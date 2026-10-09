// dsh-backroom — 宿主半（探针档）
//
// 为什么需要这一枚：宿主自己打的日志在本机没有任何人读。
//   · `ctx.logger` 唯一的出口是 cordis 自带的 1000 条内存环形缓冲
//     （`<cordis src/logger.ts:195,213-218>`），而整个产品里注册第二枚 sink 的只有
//     `dsh-app-boot/lib/index.js:4057` 那一发，且只服务"启动失败"那一条路。
//   · 宿主代码几乎只用 logger、不用 console（本窗逐包数过：dsh-hmr 19 发 logger、
//     0 发 console；dsh-settings 5/0；dsh-plugin-manager 1/0），所以"stdout 丢了"
//     不等于"没东西可看"——东西全在没人读的缓冲里。
//   · 装机桌面端里子进程 stdout 被 pipe 进 GUI 进程（丢），stderr 只留 64 KB 内存尾巴。
// 本档只回答一个问题：**零重启能不能看到宿主在说什么，以及官面服务面到底够不够得到。**
//
// 红线（本窗用户裁定，见 README.zh「刻意不做的三件事」）：
//   · 不写任何文件、不动任何会话、不碰宿主进程生死。
//   · `connection.authenticatedUrl` 只看可不可得，**绝不调用**——那把钥匙不出本进程。
//     `test/probe-shape.mjs` 里有一条哨兵把这句钉成会抛错的闸。
//   · 端点全部只读，且不带 `/api` 前缀（RULES §C4：那个前缀归 connection，插件不得占）。
//   · 第三枚 `/dsh-backroom/faults` 是**读**崩溃件目录（默认根＝桌面端 crash-*.log 那一棵，
//     可用 DSH_BACKROOM_CRASH_LOGS 指开）；只回错误行与栈帧，绝不写盘、绝不调用任何官面方法。
//     免鉴权端点不能当本机文件读 oracle ⇒ dir 参数只准落在白名单根内。

import { inspect } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// 归因面的正本住在 tools/fault-triage.mjs（CLI 与端点共用一份，不留第二套真相源）。
// 那份只做 fs 读＋纯函数：本端点不写盘、不碰进程生死。
import { scanLogs } from '../tools/fault-triage.mjs'

export const name = 'backroom'

// 只声明真正硬依赖的那一枚：'logger' 不敢进 inject——注入一枚不存在的服务是
// **永久 pending 且不报错**（PITFALLS #12），本插件要的是"取不到就降级并报出来"。
export const inject = ['webServer']

// ── 捕获面的三条硬界（10-04 23:2x 之后加的，起因是我自己把这枚插件装进真宿主后
//    后端反复退出，A/B 见 PITFALLS #103：摘掉插件 ⇒ 后端活满 120 s／GET / 回 401）──
// 1) 逐枚参数**先封顶再拼**，绝不"inspect 整枚大对象→拼整串→正则压空白"（那是事件循环上的自伤）
// 2) 重入哨兵：inspect 会调用对象的 [util.inspect.custom]，那里面可能再走 console/logger ⇒ 少这一层就是无限递归爆栈
// 3) 速率闸：单位时间内超额的捕获直接丢，并计数——捕获永远不值得把宿主拖死
const TAIL_LIMIT = 4000
const TEXT_LIMIT = 600
const ARG_LIMIT = 512
const KEY_LIMIT = 60
const RATE_LIMIT = 200
const RATE_WINDOW_MS = 1000
// LoggerLevel 的数值表（`<cordis lib/types/logger.d.ts:16-21>`）：0 error / 1 info / 2 warn / 3 debug
const LEVEL_NAMES = { 0: 'error', 1: 'info', 2: 'warn', 3: 'debug' }
// 只包这两枚：`console.info/log` 是宿主的热路径（`deepseek-account` 每个请求/响应各打两发，
// 10-04 那一帧 28 行里 26 行来自 console），把它们全量接过来不值当。
const CONSOLE_METHODS = ['error', 'warn']

// ── 崩溃件目录（/dsh-backroom/faults 的那一棵）───────────────────────────────
// 桌面端崩一次会在 %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<ISO>-{host,renderer}.log
// 留一份带栈的件（PITFALLS #103 现读）；CLI 临时实例没有这棵树，所以只走端点参数/环境变量。
const FAULT_LIMIT = 20
const toPosix = (p) => String(p).replace(/\\/g, '/')
function crashRoots() {
	const out = []
	const add = (p) => { if (typeof p === 'string' && p.trim() !== '') out.push(toPosix(path.resolve(p))) }
	add(process.env.DSH_BACKROOM_CRASH_LOGS)
	const appdata = process.env.APPDATA
	if (typeof appdata === 'string' && appdata !== '') add(path.join(appdata, '@deepseek-ai', 'dsh-desktop', 'logs'))
	return out.filter((root) => { try { return fs.existsSync(root) } catch { return false } })
}
// 源码树根（把 junction 那一路的帧认成包名用）；不给就只按"装侧包"那一档认。
function crashSourceRoots() {
	const raw = process.env.DSH_BACKROOM_SOURCE_ROOT
	if (typeof raw !== 'string' || raw.trim() === '') return []
	return raw.split(path.delimiter).map((p) => toPosix(path.resolve(p))).filter((p) => { try { return fs.existsSync(p) } catch { return false } })
}

// ── 会话窄口（10-05 用户裁定「开全套窄口」；五把闸**全部默认关**）──────────────
// 这枚端点是本插件唯一会"动手"的地方，也是唯一会花用户额度的一枚，所以判据写死在下面：
//   闸 1 env DSH_BACKROOM_SESSION_KEY 未设 ⇒ 403 disabled（等于不存在）
//   闸 2 ?key= 与 env 逐字等时比较（crypto.timingSafeEqual）
//   闸 3 sessionId 必须在 env DSH_BACKROOM_SESSION_ALLOW 名单里 ⇒ **绝不新建会话**、绝不"给最近一枚会话发"
//   闸 4 速率闸：每分钟默认 6 发，超额 429 并计数
//   闸 5 长度闸：body ≤16 KB、text ≤4000 字符、等待 ≤120 s（全部有界）
// 调用只走官面 handler（sessionController.prompt / sessionController.projections），形状现读自
// dsh-api-session-controller/lib/index.js:850（prompt）与 :3149（projections 回 {asOfSeq,values}）。
const SESSION_TEXT_LIMIT = 4000
const SESSION_BODY_LIMIT = 16_384
const SESSION_WAIT_MIN_MS = 2_000
const SESSION_WAIT_MAX_MS = 120_000
const SESSION_WAIT_DEFAULT_MS = 30_000
const SESSION_POLL_MS = 250
const SESSION_RATE_LIMIT = 6
const SESSION_RATE_WINDOW_MS = 60_000

const messageOf = (error) => String((error && error.message) || error)

/**
 * 把 logger 的 Message（或 console 的参数表）压成一行可读文本，永不抛错、永不放大。
 * 每一枚参数**先各自封顶**再拼，拼完立刻 slice——绝不对整串做一遍全局空白压缩
 * （一整串可能几 MB，那种正则会把整份复制再要一遍；10-04 后端反复退出就有它一份）。
 */
function renderArgs(args) {
	const parts = []
	for (const arg of args) {
		if (typeof arg === 'string') {
			parts.push(arg.length > ARG_LIMIT ? arg.slice(0, ARG_LIMIT) : arg)
			continue
		}
		if (arg instanceof Error) {
			const text = `${arg.name}: ${arg.message}`
			parts.push(text.length > ARG_LIMIT ? text.slice(0, ARG_LIMIT) : text)
			continue
		}
		try {
			const text = inspect(arg, { depth: 1, breakLength: 120, maxArrayLength: 12, maxStringLength: 200, sorted: false })
			parts.push(text.length > ARG_LIMIT ? text.slice(0, ARG_LIMIT) : text)
		} catch {
			parts.push('[uninspectable]')
		}
	}
	let total = 0
	for (const part of parts) total += part.length + 1
	const joined = total > TEXT_LIMIT ? parts.map((p) => (p.length > 120 ? p.slice(0, 120) : p)).join(' ').slice(0, TEXT_LIMIT) : parts.join(' ').slice(0, TEXT_LIMIT)
	return joined
}

/**
 * 有界环形尾：越界只丢最旧的，并逐枚计数（`dropped()` 说的是"丢了几条"，不是"大概丢了"）。
 * 单独导出是为了让淘汰算术能被**小规模**直接证（limit=5 跑一遍），不必为了填到 4000 条去睡 21 秒
 * 或者把默认上限调大——调大默认值就等于把闸拆了。
 */
export function createRing(limit) {
	const items = []
	let dropped = 0
	return {
		push(entry) {
			items.push(entry)
			if (items.length > limit) {
				const excess = items.length - limit
				dropped += excess
				items.splice(0, excess)
			}
			return items.length
		},
		size: () => items.length,
		dropped: () => dropped,
		slice: (count) => items.slice(-count),
		all: () => items.slice(),
	}
}

/**
 * 唯一进门口的捕获闸：**先各自封顶渲染、再入尾**，全程带两把闸——
 * ① 重入（`inspect` 会调用对象自己的 `[util.inspect.custom]`，宿主里那类对象
 *    在被 inspect 时再打一条 console ⇒ 没有这一层就是「捕获→触发日志→再捕获」，
 *    最深的一种死法是爆栈带走整枚后端）；
 * ② 速率（单位时间内超额直接丢并计数——捕获永远不值得把宿主拖死）。
 * 这条闸住在 apply 里（它要同时握著尾与计数），不另拆函数。
 */

/** JSON 安全化：函数、Symbol、循环、超深对象都不能把端点打死。 */
function jsonSafe(value, depth = 0) {
	if (value === null) return null
	const type = typeof value
	if (type === 'function') return '[function]'
	if (type === 'symbol') return String(value)
	if (type === 'bigint') return String(value)
	if (type !== 'object') return type === 'number' && !Number.isFinite(value) ? String(value) : value
	if (depth >= 4) return '[depth-limit]'
	if (Array.isArray(value)) return value.slice(0, 200).map((item) => jsonSafe(item, depth + 1))
	const out = {}
	for (const key of Object.keys(value).slice(0, 200)) {
		try {
			out[key] = jsonSafe(value[key], depth + 1)
		} catch (error) {
			out[key] = `[getter threw: ${messageOf(error)}]`
		}
	}
	return out
}

/** 一枚服务面的可见方法名（自有属性 + 原型一层），只列名字不列值。 */
function faceKeys(face) {
	const found = []
	const push = (key) => {
		if (key === 'constructor' || found.includes(key)) return
		found.push(key)
	}
	try {
		for (const key of Object.getOwnPropertyNames(face)) push(key)
		const proto = Object.getPrototypeOf(face)
		if (proto && proto !== Object.prototype) {
			for (const key of Object.getOwnPropertyNames(proto)) push(key)
		}
	} catch {
		return { keys: [], keysError: 'unreadable' }
	}
	const total = found.length
	return { keys: found.slice(0, KEY_LIMIT), keysTotal: total }
}

/**
 * 探针要问的全部服务名。分成三组只是为了把回答排得好看，判定式完全一样。
 * 'logger' 与 'profileContext' 是本次判决的关键：前者决定日志尾能不能成，
 * 后者决定官方 `dsh-hmr` 那一行 `disabled: !!js "!ctx.get('profileContext')"`
 * 在装机桌面端到底有没有被激活（`<dsh-base/cordis.patch.yml:28-32>`）。
 */
const PROBE_NAMES = [
	'webServer', 'logger', 'connection', 'sessionController', 'sessionProjections',
	'sessionPersistence', 'sessions', 'workspaceRegistry', 'agents', 'agentLoop',
	'subagents', 'agentTeams', 'planMode', 'goals', 'commands', 'tools', 'settings',
	'compaction', 'pluginInventory', 'pluginManager', 'pluginRegistryProbe', 'hmr',
	'clientModules', 'cordisInspect', 'dynamicCordisRunner', 'loader', 'profileContext',
]

export function apply(ctx) {
	// 观测计数器：端点档读它，CDP 帧也能读 globalThis 上这一枚（与 __chamberObservations 同族约定）。
	const obs = {
		plugin: 'dsh-backroom',
		shape: 'probe-only',
		appliedAt: new Date().toISOString(),
		routeRegistrations: 0,
		mountErrors: 0,
		lastError: '',
		logLines: 0,
		logDropped: 0,
		consoleLines: 0,
		reentrantSkips: 0,
		rateDropped: 0,
		captureErrors: 0,
		exporterState: 'not-attempted',
		loggerFace: 'unknown',
		bufferLenAtRegister: -1,
		bufferLenNow: -1,
		exporterFirstTsAfterApply: -1,
		consolePatchState: 'not-attempted',
		// 会话窄口的账（每一发放行/拒绝都留痕，拒绝按原因分档计数）
		session: { prompts: 0, denied: {}, rateDropped: 0, waits: 0, waitTimeouts: 0, errors: 0, lastPrompt: null },
	}
	globalThis.__backroomObservations = obs

	const ring = createRing(TAIL_LIMIT)
	let inside = false
	let windowStart = Date.now()
	let inWindow = 0
	const pushLine = (entry) => {
		ring.push(entry)
		obs.logLines = ring.size()
		obs.logDropped = ring.dropped()
	}
	/** 唯一的入口：两把闸都在渲染之前判掉，渲染本身也在闸内（重入期间绝不再进第二次）。 */
	const capture = (raw) => {
		if (inside) {
			obs.reentrantSkips += 1
			return false
		}
		const now = Date.now()
		if (now - windowStart > RATE_WINDOW_MS) {
			windowStart = now
			inWindow = 0
		}
		if (inWindow >= RATE_LIMIT) {
			obs.rateDropped += 1
			return false
		}
		inWindow += 1
		inside = true
		try {
			pushLine({
				src: raw.src,
				sn: raw.sn,
				ts: raw.ts,
				name: raw.name,
				type: raw.type,
				level: raw.level,
				text: renderArgs(raw.args),
			})
			if (raw.src === 'console') obs.consoleLines += 1
			if (raw.src === 'logger' && obs.exporterFirstTsAfterApply < 0) obs.exporterFirstTsAfterApply = now
			return true
		} catch {
			obs.captureErrors += 1
			return false
		} finally {
			inside = false
		}
	}

	// ── 1) 日志尾：注册 ctx.logger.exporter ──────────────────────────────
	// 先 ctx.get 再退属性访问，两条路各自记下结果——这本身就是 #100 那格的一枚读数。
	let loggerFace = undefined
	try {
		loggerFace = ctx.get('logger', false)
		obs.loggerFace = loggerFace === undefined ? 'absent-via-get' : `present(${typeof loggerFace})`
	} catch (error) {
		obs.loggerFace = `get-threw: ${messageOf(error)}`
	}
	if (loggerFace === undefined) {
		try {
			loggerFace = ctx.logger
			if (loggerFace !== undefined) obs.loggerFace = 'present-via-property'
		} catch { /* 面具拦住属性访问是预期行为，不记错 */ }
	}

	if (loggerFace !== undefined && typeof loggerFace.exporter === 'function') {
		try {
			const before = Array.isArray(loggerFace.buffer) ? loggerFace.buffer.length : -1
			obs.bufferLenAtRegister = before
			loggerFace.exporter({
				export(message) {
					try {
						capture({
							src: 'logger',
							sn: message && typeof message.sn === 'number' ? message.sn : -1,
							ts: message && typeof message.ts === 'number' ? message.ts : Date.now(),
							name: String((message && message.name) || ''),
							type: String((message && message.type) || LEVEL_NAMES[message && message.level] || 'info'),
							level: typeof message.level === 'number' ? message.level : 1,
							args: Array.isArray(message && message.args) ? message.args : [],
						})
					} catch { /* 日志面永不把宿主带下去 */ }
				},
			})
			obs.exporterState = 'registered'
		} catch (error) {
			obs.exporterState = `threw: ${messageOf(error)}`
			obs.mountErrors += 1
			obs.lastError = messageOf(error)
		}
	} else if (loggerFace !== undefined) {
		obs.exporterState = 'logger-face-without-exporter'
	}

	// ── 2) 控制台尾：只接 `console.error`／`console.warn`（10-04 事故后收窄，见 #103）──
	// 曾经包的是全五枚，而宿主的热路径走 console.info（`deepseek-account` 每发请求两发响应），
	// 全量接管＝把捕获放在最忙的那条路上。还原也只认自己那枚标记，绝不踩别人的补丁。
	const consoleOriginals = {}
	let alreadyWrapped = 0
	try {
		for (const method of CONSOLE_METHODS) {
			const original = console[method]
			if (typeof original !== 'function') continue
			// 重复 apply（热重载/重建纤维）时**不再套第二层**：套了就没有"还原到干净"这条路。
			if (original.__backroomWrapped === true) {
				alreadyWrapped += 1
				continue
			}
			consoleOriginals[method] = original
			const replacement = (...args) => {
				try {
					capture({ src: 'console', sn: -1, ts: Date.now(), name: `console.${method}`, type: method, level: method === 'error' ? 0 : 2, args })
				} catch { /* 同上 */ }
				return original.apply(console, args)
			}
			replacement.__backroomWrapped = true
			console[method] = replacement
		}
		obs.consolePatchState = `patched(${Object.keys(consoleOriginals).length}:${CONSOLE_METHODS.join('/')})${alreadyWrapped ? ` already-wrapped(${alreadyWrapped})` : ''}`
		if (Object.keys(consoleOriginals).length === 0) {
			obs.consolePatchState += ' (no-op)'
		} else {
			ctx.effect(() => () => {
				for (const [method, original] of Object.entries(consoleOriginals)) {
					if (console[method] && console[method].__backroomWrapped === true) console[method] = original
				}
				obs.consolePatchState = 'restored'
			}, 'dsh-backroom console patch')
		}
	} catch (error) {
		obs.consolePatchState = `threw: ${messageOf(error)}`
		obs.mountErrors += 1
	}

	// ── 3) 探针读数（每次请求现算，不缓存——缓存的帧就不是"当回合证据"了）──
	function probeService(name) {
		const row = { name }
		try {
			const strict = ctx.get(name, true)
			row.strict = strict === undefined ? 'absent' : `present(${typeof strict})`
			if (strict !== undefined) Object.assign(row, faceKeys(strict))
		} catch (error) {
			row.strict = `threw: ${messageOf(error)}`
		}
		try {
			const loose = ctx.get(name, false)
			row.loose = loose === undefined ? 'absent' : `present(${typeof loose})`
			if (row.keys === undefined && loose !== undefined) Object.assign(row, faceKeys(loose))
		} catch (error) {
			row.loose = `threw: ${messageOf(error)}`
		}
		return row
	}

	function envNames() {
		try {
			return Object.keys(process.env).filter((key) => key.startsWith('DSH_')).sort()
		} catch {
			return ['unreadable']
		}
	}

	function buildProbe() {
		const services = PROBE_NAMES.map(probeService)
		const propertyAccess = {}
		for (const name of ['webServer', 'logger', 'commands', 'sessionController']) {
			try {
				const value = ctx[name]
				propertyAccess[name] = value === undefined ? 'undefined' : `present(${typeof value})`
			} catch (error) {
				propertyAccess[name] = `threw: ${messageOf(error)}`
			}
		}
		let bufferLen = -1
		let bufferHead = []
		try {
			if (loggerFace !== undefined && Array.isArray(loggerFace.buffer)) {
				bufferLen = loggerFace.buffer.length
				obs.bufferLenNow = bufferLen
				// 缓冲头部几枚（= 本插件 apply **之前**就在场的）——这一发直接判"能不能回放"。
				bufferHead = loggerFace.buffer.slice(0, 3).map((message) => renderArgs(Array.isArray(message && message.args) ? message.args : []))
			}
		} catch { /* 取不到就留 -1，不猜 */ }

		// hmr 只**问名字，不动手**。10-04 的实证：从探针里调 `hmr.getLinked()` 会让 ESM
		// LoadCache 拿到 undefined 的 url（`<dsh-hmr/lib/index.js:462>` 那个 Proxy 只在它自己的
		// loader hook 上下文里成立），抛发生在 loader 的 tick 上 ⇒ 本端的 try/catch 拦不到，
		// 后端直接 `dsh: fatal load failure` 退出（真凭据见 PITFALLS #103 的栈）。
		// 所以这里只报"方法在不在"，把"它眼下 watch 什么"留给读得懂的那一侧。
		let hmr = { face: 'absent' }
		const hmrFace = ctx.get('hmr', false)
		if (hmrFace !== undefined) {
			hmr = {
				face: `present(${typeof hmrFace})`,
				methods: Object.keys(hmrFace).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(hmrFace) || {})).slice(0, 24),
				getLinked: 'not-called（loader-hook 专用，从外部调会把后端拖死，10-04 实测）',
			}
		}

		return {
			ok: true,
			plugin: obs,
			host: {
				node: process.version,
				platform: process.platform,
				pid: process.pid,
				execArgv: process.execArgv,
				// argv 里可能带路径，绝不含 token；仍然按 token 关键字过滤一遍再走。
				argv: process.argv.filter((item) => !/token/i.test(item)),
				dshEnvNames: envNames(),
			},
			fiberState: (() => {
				try {
					return ctx.fiber ? ctx.fiber.state : 'no-ctx-fiber'
				} catch (error) {
					return `threw: ${messageOf(error)}`
				}
			})(),
			propertyAccess,
			hmr,
			buffer: { len: bufferLen, head: bufferHead },
			services,
		}
	}

	// ── 4) 两枚只读端点 ────────────────────────────────────────────────
	const sendJson = (res, status, value) => {
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
		res.end(JSON.stringify(jsonSafe(value)))
	}

	const queryOf = (url) => {
		try {
			const index = url.indexOf('?')
			return index < 0 ? {} : Object.fromEntries(new URLSearchParams(url.slice(index + 1)))
		} catch {
			return {}
		}
	}

	const logsHandler = (req, res) => {
		try {
			const query = queryOf(req.url || '')
			const limit = Math.max(1, Math.min(TAIL_LIMIT, Number(query.limit) || 200))
			// level 允许两种写法：数值档（0..3，官面 LoggerLevel）或名字（error/info/warn/debug）。
			const raw = query.level === undefined ? '' : String(query.level)
			let levelName = null
			if (raw !== '') {
				levelName = LEVEL_NAMES[raw] || (Object.values(LEVEL_NAMES).includes(raw) ? raw : null)
				if (levelName === null) return sendJson(res, 400, { ok: false, reason: 'bad-level', allowed: Object.values(LEVEL_NAMES) })
			}
			const contains = typeof query.contains === 'string' ? query.contains : ''
			let lines = ring.all()
			if (levelName !== null) lines = lines.filter((entry) => entry.type === levelName)
			if (contains) lines = lines.filter((entry) => entry.text.includes(contains) || entry.name.includes(contains))
			const picked = lines.slice(-limit)
			sendJson(res, 200, { ok: true, tailTotal: ring.size(), returned: picked.length, limit, dropped: ring.dropped(), rate: { limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS, reentrantSkips: obs.reentrantSkips, rateDropped: obs.rateDropped, captureErrors: obs.captureErrors }, plugin: obs, lines: picked })
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error) })
		}
	}

	const probeHandler = (req, res) => {
		try {
			sendJson(res, 200, buildProbe())
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error) })
		}
	}

	const faultsHandler = (req, res) => {
		try {
			const query = queryOf(req.url || '')
			const roots = crashRoots()
			if (roots.length === 0) return sendJson(res, 200, { ok: false, reason: 'no-crash-root', hint: '桌面端崩溃件目录不在场（CLI 实例没有那棵树）。给 CLI 实例设 DSH_BACKROOM_CRASH_LOGS=<自己的日志目录> 再来。' })
			let dir = roots[0]
			if (typeof query.dir === 'string' && query.dir.trim() !== '') {
				const want = toPosix(path.resolve(query.dir))
				// 只准落在白名单根内：这一枚端点免鉴权（同 /dsh-chamber/*），不能当本机任意文件的读 oracle
				if (!roots.some((root) => want === root || want.startsWith(root + '/'))) {
					return sendJson(res, 403, { ok: false, reason: 'dir-outside-allowed-roots', allowed: roots })
				}
				dir = want
			}
			const limit = Math.max(1, Math.min(FAULT_LIMIT, Number(query.limit) || 8))
			const rows = scanLogs({ logs: [dir], sourceRoots: crashSourceRoots(), limit, maxFiles: FAULT_LIMIT })
			sendJson(res, 200, {
				ok: true,
				dir,
				roots,
				returned: rows.length,
				tier: '文件投影档（读的是崩溃件，不是屏帧，也不是"当场抓到"）',
				faults: rows.map((r) => ({
					file: toPosix(r.file).split('/').pop(),
					time: r.time,
					phase: r.phase,
					source: r.source || 'stdout',
					errCode: r.errCode ?? null,
					exitCode: r.exitCode ?? null,
					rendererState: r.rendererState ?? null,
					fatalLine: r.fatalLine,
					frameCount: r.frameCount,
					truncated: r.truncated,
					culprit: r.culprit ? { bundle: r.culprit.bundle, frame: r.culprit.frame, file: toPosix(r.culprit.file), line: r.culprit.line, via: r.culprit.via } : null,
					official: r.official ? { frame: r.official.frame, file: toPosix(r.official.file), line: r.official.line } : null,
					noCulpritReason: r.noCulpritReason ?? null,
				})),
				next: '摘掉＝命令行（不是本端点）：node tools/dsh-fault-triage.mjs quarantine --bundle auto --profile-dir <profile 目录> [--apply]；本端点只读，绝不写 profile、绝不重启宿主。',
			})
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error) })
		}
	}

	// ── 5) 会话窄口：GET 读状态／POST 发一发 prompt（默认关，五把闸逐把过）──────
	const sess = obs.session
	const deny = (reason) => { sess.denied[reason] = (sess.denied[reason] || 0) + 1; return reason }

	// 闸 1＋2：env 没设 key＝这枚端点整体不放行；设了才逐字比（等时比较，不泄露长度以外的信息）
	const keyVerdict = (given) => {
		const want = process.env.DSH_BACKROOM_SESSION_KEY
		if (typeof want !== 'string' || want === '') return 'disabled'
		if (typeof given !== 'string' || given === '') return 'no-key'
		const a = Buffer.from(given, 'utf8')
		const b = Buffer.from(want, 'utf8')
		if (a.length !== b.length) return 'bad-key'
		try { return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad-key' } catch { return 'bad-key' }
	}
	// 闸 3：只认登记过的 sessionId。绝不新建会话、绝不"挑最近一枚"——那是这一格的省钱与安全边界
	const allowVerdict = (sessionId) => {
		const raw = process.env.DSH_BACKROOM_SESSION_ALLOW
		if (typeof raw !== 'string' || raw.trim() === '') return 'no-allowlist'
		if (typeof sessionId !== 'string' || sessionId === '') return 'no-session'
		const list = raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
		return list.includes(sessionId) ? 'ok' : 'not-allowlisted'
	}
	// 闸 4：速率（一分钟窗口内超额直接 429，并计数）
	const rateVerdict = () => {
		const now = Date.now()
		sess.stamps = (sess.stamps || []).filter((t) => now - t < SESSION_RATE_WINDOW_MS)
		if (sess.stamps.length >= SESSION_RATE_LIMIT) return 'rate-limited'
		sess.stamps.push(now)
		return 'ok'
	}
	const readBody = (req) => new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > SESSION_BODY_LIMIT) { reject(new Error('body-too-large')); req.destroy(); return }
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
	// 官面读侧（10-09 现读定形，别再猜字段）：`session/projections` 的 values 袋里**没有** `turnBoundary`
	// （那是循环自用单位），在册的是 `turnOutline`（view＝回合数组 `{turn,seq,prompt,response}`，
	// `response` 由 `turn/end` 那一发填上）与 `sessionStats`（含 `turns`/`lastTurn`）。判据建在这两枚上。
	const readTurnFace = async (sessionId) => {
		const sc = ctx.get('sessionController', false)
		if (!sc || typeof sc.projections !== 'function') return { face: 'no-sessionController' }
		try {
			const p = await sc.projections({ sessionId }, new AbortController().signal)
			if (!p) return { face: 'session-not-found' }
			const values = p.values && typeof p.values === 'object' ? p.values : {}
			const outline = Array.isArray(values.turnOutline) ? values.turnOutline : null
			const stats = values.sessionStats && typeof values.sessionStats === 'object' ? values.sessionStats : null
			const sel = values.modelSelection && typeof values.modelSelection === 'object' ? values.modelSelection : null
			const pick = (row) => (row && typeof row === 'object' && typeof row.model === 'string'
				? { provider: String(row.provider || ''), model: row.model, ...(typeof row.reasoningEffort === 'string' ? { reasoningEffort: row.reasoningEffort } : {}) }
				: null)
			const last = outline && outline.length ? outline[outline.length - 1] : null
			const turnCount = stats && typeof stats.turns === 'number' ? stats.turns : (outline ? outline.length : null)
			return {
				face: 'ok',
				asOfSeq: p.asOfSeq ?? null,
				turnCount,
				lastTurn: last && typeof last.turn === 'number' ? last.turn : null,
				lastResponseChars: last && typeof last.response === 'string' ? last.response.length : null,
				statsLastTurn: stats && 'lastTurn' in stats ? jsonSafe(stats.lastTurn, 0) : 'absent',
				// 只读的那一格：这一枚会话现在用哪个 provider/model（**切模型不在范围内**——它会改变后续每一发的计费）
				model: sel ? { lastUsed: pick(sel.lastUsed), next: pick(sel.next) } : null,
				projectionKeys: Object.keys(values).slice(0, 40),
				readable: typeof turnCount === 'number',
			}
		} catch (error) { return { face: 'threw', message: messageOf(error).slice(0, 200) } }
	}

	const sessionHandler = async (req, res) => {
		try {
			const query = queryOf(req.url || '')
			const verdict = keyVerdict(query.key)
			if (verdict !== 'ok') {
				return sendJson(res, 403, { ok: false, reason: deny(verdict), hint: '窄口默认关：设 DSH_BACKROOM_SESSION_KEY＋DSH_BACKROOM_SESSION_ALLOW=<sid1,sid2> 才放行；本端点绝不新建会话' })
			}
			const sc = ctx.get('sessionController', false)
			if (!sc) return sendJson(res, 200, { ok: false, reason: 'no-sessionController' })
			const sessionId = typeof query.session === 'string' ? query.session : ''
			if (req.method === 'GET') {
				const allowed = allowVerdict(sessionId)
				if (allowed !== 'ok') return sendJson(res, 403, { ok: false, reason: deny(allowed) })
				return sendJson(res, 200, { ok: true, sessionId, ...(await readTurnFace(sessionId)) })
			}
			if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
			const allowed = allowVerdict(sessionId)
			if (allowed !== 'ok') return sendJson(res, 403, { ok: false, reason: deny(allowed) })
			const rate = rateVerdict()
			if (rate !== 'ok') { sess.rateDropped += 1; return sendJson(res, 429, { ok: false, reason: deny(rate), limit: SESSION_RATE_LIMIT, windowMs: SESSION_RATE_WINDOW_MS }) }
			let payload
			try {
				payload = JSON.parse((await readBody(req)) || '{}')
			} catch (error) {
				const reason = messageOf(error) === 'body-too-large' ? 'body-too-large' : 'bad-json'
				return sendJson(res, 400, { ok: false, reason: deny(reason) })
			}
			const text = typeof payload.text === 'string' ? payload.text : ''
			if (text.trim() === '') return sendJson(res, 400, { ok: false, reason: deny('empty-text') })
			if (text.length > SESSION_TEXT_LIMIT) return sendJson(res, 400, { ok: false, reason: deny('text-too-long'), limit: SESSION_TEXT_LIMIT })
			const before = await readTurnFace(sessionId)
			const requestId = crypto.randomUUID()
			let admitted
			try {
				// 第二枚参数是官面 handler 要的取消信号（10-05 实测：不带它 ⇒ 在解析会话那一步
				// 撞 `Cannot read properties of undefined (reading 'throwIfAborted')`，看着像"会话不存在"，其实是我们少传了参数）
				admitted = await sc.prompt({ sessionId, requestId, content: [{ type: 'text', text }] }, new AbortController().signal)
			} catch (error) {
				sess.errors += 1
				// 诊断照官面原样带出来（RemoteError 有 code；非 RemoteError 就把 name＋栈头三行给你，别让下一个人再考古）
				const stack = error && typeof error === 'object' && error.stack ? String(error.stack).split(/\r?\n/).slice(1, 4).map((l) => l.trim()) : []
				return sendJson(res, 502, {
					ok: false, stage: 'prompt', sessionId, requestId,
					reason: (error && error.code) || (error && error.name) || 'threw',
					message: messageOf(error).slice(0, 300),
					stackHead: stack,
				})
			}
			sess.prompts += 1
			sess.lastPrompt = { sessionId, requestId, at: new Date().toISOString() }
			const base = { ok: true, sessionId, requestId, accepted: Boolean(admitted && admitted.accepted === true), before }
			if (query.wait !== 'turn-end') return sendJson(res, 200, { ...base, wait: 'not-requested', note: '没带 wait=turn-end ⇒ 只报"官面接没接"，不报回合结束' })
			// 等待＝**带 deadline 的界内轮询**官面投影，回包把读数全带出来（不用固定等待换确定性）
			const budget = Math.max(SESSION_WAIT_MIN_MS, Math.min(SESSION_WAIT_MAX_MS, Number(query.timeoutMs) || SESSION_WAIT_DEFAULT_MS))
			const startedAt = Date.now()
			sess.waits += 1
			let face = before
			const advanced = (f) => typeof f.turnCount === 'number' && typeof before.turnCount === 'number' && f.turnCount > before.turnCount
			while (Date.now() - startedAt < budget) {
				await new Promise((r) => setTimeout(r, SESSION_POLL_MS))
				face = await readTurnFace(sessionId)
				if (advanced(face) && (face.lastResponseChars ?? 0) > 0) break
			}
			const waitedMs = Date.now() - startedAt
			const started = advanced(face)
			const responded = (face.lastResponseChars ?? 0) > 0
			const ended = started && responded
			if (!ended) sess.waitTimeouts += 1
			const blind = face.readable !== true
			return sendJson(res, 200, {
				...base,
				ended,
				endedClaim: blind ? 'unreadable' : ended ? 'yes' : 'not-yet',
				turnStarted: started,
				assistantResponded: responded,
				waitedMs, deadlineMs: budget, pollMs: SESSION_POLL_MS, after: face,
				note: blind
					? `**判据读不到**：官面投影袋里既没有 turnOutline 数组也没有 sessionStats.turns（键名见 after.projectionKeys）⇒ 这发不能判结束，也不许写成"没结束"。`
					: ended ? 'turnOutline 多出一回合且那一回合的 response 已由 turn/end 填上＝官面记到一发完整回合（投影档，不等于屏帧）' : started ? `回合起了但那一回合的 response 还是空（可能纯工具回合或还没完）：turnCount ${before.turnCount}→${face.turnCount}，等了 ${waitedMs} ms／上限 ${budget} ms` : `界内没起新回合＝还没记到 turn/start：等了 ${waitedMs} ms／上限 ${budget} ms，末帧 asOfSeq=${String(face.asOfSeq)}`,
			})
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error).slice(0, 300) })
		}
	}

	const routes = [
		{ kind: 'exact', path: '/dsh-backroom/probe', handler: probeHandler },
		{ kind: 'exact', path: '/dsh-backroom/logs', handler: logsHandler },
		{ kind: 'exact', path: '/dsh-backroom/faults', handler: faultsHandler },
		{ kind: 'exact', path: '/dsh-backroom/session', handler: sessionHandler },
	]
	// 装配期注册会抛（cordis 的 fiber.assertActive，PITFALLS #66 那族 ⇒ RULES 里"整包被带走"的那一型），
	// 所以逐枚 try/catch + 计数，绝不裸奔。
	for (const route of routes) {
		try {
			const dispose = ctx.webServer.register(route)
			obs.routeRegistrations += 1
			ctx.effect(() => dispose, `dsh-backroom route ${route.path}`)
		} catch (error) {
			obs.mountErrors += 1
			obs.lastError = `${route.path}: ${messageOf(error)}`
		}
	}

	if (typeof loggerFace?.info === 'function') loggerFace.info('[backroom] host half ready (4 routes: probe, logs, faults, session — 最后枚默认关，需 env key＋allow)')
	else console.log('[backroom] host half ready (4 routes: probe, logs, faults, session)')
}
