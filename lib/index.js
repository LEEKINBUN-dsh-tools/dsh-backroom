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
// 本档回答两个问题：**零重启能不能看到宿主在说什么，以及官面服务面到底够不够得到。**
// 10-09 起多了"动手"的两格（发 prompt、建工作区）；10-19 用户改判「不需要切换模型，其他做完」⇒
// 再加两格：**建一枚会话（同时带上官面名册里的档位）**与**把本插件建的那几枚收回去**。
// 改判的理由要留在码里，不然下一个人会把它当"安全边界"重新焊回去：
// 旧那句"绝不给任意会话一个替你花钱的按钮"把风险说成了**支出**，而支出这一维没有不对称
// （代理发一发与宿主自己跑一轮，账单同一个口袋）。真正外移的是另外三样——
// **这枚会话挂哪棵目录／生效哪一枚权限档／造出来能不能收回去** ⇒ 约束因此**换轴**而不是取消：
//   · 范围闸：`cwd` 必须落在 `DSH_BACKROOM_WORKSPACE_ROOTS` 内（没设＝建会话整格 disabled）
//   · 名册闸：档位必须**当场**从官面 `agentPresets.list()` 里取到，激活失败那枚（带 `broken`）也拒
//   · 名额闸：默认每小时 3 枚（每建一枚都在你 profile 里长一份资产，而官面"归档"只是隐藏）
//   · 预算闸：默认 60,000 token——标度来源＝本窗靶会话 durable 日志实测 14,920 token/回合 ×4
//   · 档位闸：**只读** `permissions` 投影做判定并**逐发回显**；默认不拦（本机 `permissionPresets.defaultPreset`
//     实测就是 `danger-full-access`，拦它＝新建的会话全废），要拦请点名 `DSH_BACKROOM_DENY_PRESETS=<名单>`；
//     本插件**从不**调 `permissionPresets.set`（改权限档＝放宽，哨兵红）、**从不**调 `agentPresets.select`（那是改**活会话**档位）
//   · 归属闸：建出来的会话标题带 `backroom:<caller>`；**owned 之外**的会话既不能被本插件归档，也不需要 env 才放行
// 其余红线一字没松：
//   · 插件自己**绝不写任何文件**、不碰宿主进程生死（写盘只有命令行 `quarantine --apply`，且先备份）。
//   · `connection.authenticatedUrl` 只看可不可得，**绝不调用**——那把钥匙不出本进程（哨兵盯）。
//   · 外来服务面上**逐面白名单**（第 17 步按"哪枚面、调了什么"判）：会话面 `create`／`prompt`／`projections`／`rename`，
//     工作区面 `create`／`archiveSession`／`unarchiveSession`，名册面只 `list`，权限档面只 `catalog`。
//     其余（含 10-04 那发拖死后端的 `hmr.getLinked`）出现即红。
//   · 五枚只读端点（probe／logs／faults／presets／declarations）不带 `/api` 前缀（RULES §C4 那个前缀归 connection）；
//     `faults` 只读崩溃件目录，`dir` 只准落在白名单根内（免鉴权端点不能当本机文件读 oracle）。
//   · 三枚动手端点默认关（env key）；工作区/WSL 那两档默认也关（roots／distros 白名单）。
//     11-01 起的三件新增（都源自当天的实战会话）：declarations＝声明体内文（痛点 1）、
//     probe 的 self/loadedPlugins＝加载副本自证（痛点 3）、console 全五枚捕获（痛点 4）、
//     reload＝按插件热重载（痛点 2，机制与边界见 5d 节）＋tools/discover.mjs（痛点 5）。

import { inspect } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
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
// 11-01 用户裁定把捕获面扩到**全 console 级别**（痛点 4：插件的 console.log 诊断行
// `WSL preset variants: 4/4 registered` 之前在 logs 路由里看不见）。10-04 只包 error/warn 的
// 理由是"热路径全量接管＝把捕获放在最忙的那条路上"——那一格的**真**成因（无界 inspect＋整串
// 全局正则）早被 renderArgs/逐参数封顶治掉了，剩下的开销只是每发一次两把闸的判断。
// 作为补偿，速率闸改**双档**：error/warn 一档、info/log/debug 一档，各占满额 200/秒 ——
// 信息洪峰把 normal 档打穿时，error/warn 的取证档不被陪葬。
const CONSOLE_METHODS = ['error', 'warn', 'info', 'log', 'debug']
const CONSOLE_LEVEL_OF = { error: 0, warn: 2, info: 1, log: 1, debug: 3 }
const CONSOLE_TIER_OF = { error: 'forensic', warn: 'forensic', info: 'normal', log: 'normal', debug: 'normal' }
// level 过滤的合法名字＝官面数值档四枚 ＋ console 方法名（console.log 那路的 type 就是 'log'）。
const LEVEL_FILTER_NAMES = { 0: 'error', 1: 'info', 2: 'warn', 3: 'debug', log: 'log' }

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
// 建会话那一档的上限。两个数字都**不许凭手感**，标度来源写在后面：
//   · SESSION_CREATE_LIMIT_PER_HOUR＝3 —— 本窗实测：建一枚会话＋打标记＋发一问＝3 件盘上资产，
//     而归档只是"从分组面摘掉"（官面原句 `Hide one known Session from Workspace grouping surfaces`），
//     残留（sessions/ 树＋projcache＋attachments）要用户自己清 ⇒ 名额先卡小，放开要用户改 env 点名。
//   · SESSION_BUDGET_TOKENS_PER_HOUR＝60000 —— 标度来源＝靶会话 session-f16dc7f3 的 durable 日志实测：
//     四个回合的 tokenUsage 桶分别是 13,762／13,847／14,794／17,276，均值 **14,920** ⇒ 60,000 ≈ 4 个回合。
//     要抬这一格必须带新的实测数来（同 RULES 里 GIT_TIMEOUT 那条口径：不许为过门抬数）。
const SESSION_CREATE_LIMIT_PER_HOUR = 3
const SESSION_BUDGET_TOKENS_PER_HOUR = 60_000
const SESSION_CREATE_BODY_LIMIT = 4096

const messageOf = (error) => String((error && error.message) || error)

// ── 工具面里那三枚"值判"纯函数（导出＝让夹具能真验它们，不只在真宿主上碰运气）──────────
/** /mnt/<盘>/x → <盘>:\x；不是 /mnt 形就回 null（那时该走 UNC）。 */
export function mntToWindowsPath(linuxPath) {
	const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(String(linuxPath || ''))
	if (!m) return null
	return `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/^\//, '').replace(/\//g, '\\')}`
}
/** 建一枚 WSL 工作区该递给官面 create 的那枚路径，以及走哪支（与 dsh-wsl-workspace 客户端同顺序）。 */
export function wslTargets(distro, linuxPath) {
	const win = mntToWindowsPath(linuxPath)
	if (win !== null) return { target: win, branch: 'mnt-drive' }
	return { target: `\\\\wsl.localhost\\${distro}\\${String(linuxPath).replace(/^\//, '').replace(/\//g, '\\')}`, branch: 'unc' }
}
/** 前缀白名单判定（env 原值 + 待测路径）。没设＝disabled，绝不"顺手放行"。 */
export function rootGate(envValue, target) {
	if (typeof envValue !== 'string' || envValue.trim() === '') return 'disabled'
	// Windows 路径大小写不敏感（`d:\temp\x` 与 `D:\Temp\x` 是同一棵），所以 win32 上折叠大小写再比：
	// 10-30 实测形状——工作区记录里存的是小写盘符/目录，roots 按人习惯写大写 ⇒ 逐字比会误判成越界。
	const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
	const norm = (p) => fold(String(p).replace(/\\/g, '/').replace(/\/+$/, ''))
	const roots = envValue.split(/[;,]/).map((s) => norm(s.trim())).filter((s) => s !== '')
	const t = norm(target)
	return roots.some((r) => t === r || t.startsWith(r + '/')) ? 'ok' : 'outside-roots'
}
/** 发行版白名单判定（同一形状，逐项相等）。 */
export function distroGate(envValue, distro) {
	if (typeof envValue !== 'string' || envValue.trim() === '') return 'disabled'
	const list = envValue.split(/[;,]/).map((s) => s.trim()).filter((s) => s !== '')
	return list.includes(distro) ? 'ok' : 'not-allowed-distro'
}

// ── 建会话那一档的判定式（10-19 用户改判：「不需要切换模型，其他做完」）───────────
// 为什么不再是"绝不新建会话"：那条红线的名字（"绝不给任意会话一个替你花钱的按钮"）把风险说成了
// **支出**，而钱这一维没有不对称——我发一发 prompt 与宿主自己跑一轮，账单走同一个口袋。
// 真正外移的是另外三样：**这枚会话挂哪棵目录／生效的是哪一枚权限档／造出来能不能收回去**。
// 所以约束从"一刀不许"换成"逐样量"：范围闸（rootGate）、名册闸（presetGate）、名额闸（hourWindow）、
// 预算闸（budgetGate）、档位闸（denyGate）、归属标记（callerMarker），外加回收通道（官面 archiveSession）。
// 每一枚都是**导出纯函数**＝夹具能真验，不等真宿主碰运气。
/** 名册闸：想用的预设必须**当场**在官面名册里，且不能是激活失败的那一枚；可选二次白名单。 */
export function presetGate(roster, wanted, allowList) {
	if (!Array.isArray(roster)) return 'roster-unavailable'
	const row = roster.find((p) => p && p.id === wanted)
	if (!row) return 'not-in-roster'
	if (typeof row.broken === 'string' && row.broken !== '') return 'broken-preset'
	const list = typeof allowList === 'string' ? allowList.split(/[;,]/).map((s) => s.trim()).filter((s) => s !== '') : []
	if (list.length > 0 && !list.includes(wanted)) return 'not-allowed-preset'
	return 'ok'
}
/** 名额闸：滑动窗口内还能不能再建一枚（建会话会往用户 profile 里长资产，所以名额先于一切写动作）。 */
export function hourWindow(limit, windowMs = 3_600_000) {
	let marks = []
	const prune = (now) => { marks = marks.filter((t) => now - t < windowMs) }
	return {
		take(now = Date.now()) {
			prune(now)
			if (limit > 0 && marks.length >= limit) return { ok: false, used: marks.length, limit }
			marks.push(now)
			return { ok: true, used: marks.length, limit }
		},
		// 后面的闸挂了要把自己刚占的名额**退回**，否则一次失败的范围越界会白吃掉一小时的名额
		undo(now = Date.now()) { marks.pop(); prune(now); return { used: marks.length, limit } },
		peek(now = Date.now()) { prune(now); return { used: marks.length, limit } },
	}
}
/** 预算闸：本插件建的会话累计 token 与上限的比较（上限的标度来源见 SESSION_BUDGET 那条注释）。 */
export function budgetGate(spentTokens, limitTokens) {
	if (!(limitTokens > 0)) return { verdict: 'unbounded', spentTokens, limitTokens }
	return { verdict: spentTokens >= limitTokens ? 'budget-exceeded' : 'ok', spentTokens, limitTokens }
}
/**
 * 档位闸：会话实际生效的权限档命中禁止名单就拒写（读的是官面 `permissions` 投影的 currentValue）。
 * ⚠ 10-19 真宿主实测把这格的**默认值**从"禁 danger-full-access"改成"空＝不拦、只回显"：
 *   这台机器的 `permissionPresets.defaultPreset` 现读就是 `danger-full-access`，拦它等于
 *   新建的会话一枚都用不了——那是把"默认关"换了个地方，不是约束。
 *   "不许放宽档"改由**结构**保证：本插件不调 `permissionPresets.set`、不写档位（第 17 步哨兵红），
 *   所以它做不到放宽；真要拦某一档请点名 `DSH_BACKROOM_DENY_PRESETS=<名单>`。
 */
export function denyGate(currentValue, denyEnvValue, defaultDeny = '') {
	const raw = typeof denyEnvValue === 'string' ? denyEnvValue : defaultDeny
	const list = raw.split(/[;,]/).map((s) => s.trim()).filter((s) => s !== '')
	if (list.length === 0) return 'ok'
	if (typeof currentValue !== 'string' || currentValue === '') return 'unknown-preset'
	return list.includes(currentValue) ? 'denied-preset' : 'ok'
}
/** 归属标记：建出来的会话标题带调用方，让用户在侧栏一眼认出是谁造的（也是"我造的才准我归档"的依据）。 */
export function callerMarker(caller) {
	// 消毒三下：只留 [\w. - 空格]、连点塌成一枚点、去掉开头的点与空白。
	// 标题会进侧栏、也会被抄进各种命令行，所以不许留 `..`／路径分隔符这类形状。
	const c = String(caller ?? '').replace(/[^\w.\- ]/g, '').replace(/\.{2,}/g, '.').replace(/^[.\s]+/, '').trim().slice(0, 40)
	if (c === '') return { ok: false, reason: 'bad-caller' }
	return { ok: true, title: `backroom:${c}`, caller: c }
}
/** tokenUsage 投影 view 就是那四枚桶（现读自打包码 `view: (state) => state.totals`）；求和成一枚标量。 */
export function tokenSpend(view) {
	if (!view || typeof view !== 'object') return 0
	const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
	let sum = 0
	for (const k of keys) { const n = Number(view[k]); if (Number.isFinite(n) && n > 0) sum += n }
	return sum
}
/**
 * 自家路由被访问时 Host 头里那枚**环回** origin。
 * 0.2.1-rc.2 起后端端口每次启动随机（`--port 0`），"猜一个端口"这种默认值会打到死口上 ⇒
 * 本插件只认自己真被以哪个 origin 访问过。非环回（如 `evil.example:80`）一律回 ''，
 * 否则 Host 头就成了"让插件去请求外部主机"的通道（SSRF）。
 */
export function loopbackOrigin(headerValue) {
	const h = String(headerValue || '').trim().toLowerCase()
	return /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(h) ? h : ''
}
/** WSL 桥基址的定法：env 显式给 > 自家 Host 头观察到 > 如实 unknown（**绝不回落到某个写死的端口**）。 */
export function bridgeBase(envValue, origin) {
	if (typeof envValue === 'string' && envValue.trim() !== '') return { base: envValue.trim(), source: 'env' }
	if (typeof origin === 'string' && origin !== '') return { base: `http://${origin}`, source: 'observed-host-header' }
	return { base: '', source: 'unknown', reason: 'bridge-base-unknown：0.2.1-rc.2 起后端端口随机，本插件不猜端口。设 DSH_BACKROOM_BRIDGE_BASE=http://127.0.0.1:<端口>，或先打一发本插件自家任一端点（探针会因此认到自己被访问的那枚环回 origin）。' }
}

/** reload 证据行的判据（11-01 痛点 2）：官方热重载完成后打的那行 logger（name='hmr'）。 */
export function reloadEvidenceLine(entry) {
	return Boolean(entry && entry.name === 'hmr' && typeof entry.text === 'string' && /reload plugin at/.test(entry.text))
}

/**
 * reload 那一格用的 profile 目录：env `DSH_BACKROOM_PROFILE_DIR` 显式给 > 官面进程形状的
 * argv[3]（桌面端＝profile 目录，10-30 现读）> 空。env 覆盖也让 CLI 形实例（argv 形状不同）
 * 与夹具都能指路。
 */
export function profileDirOf(envValue, argv3) {
	if (typeof envValue === 'string' && envValue.trim() !== '') return envValue.trim()
	return typeof argv3 === 'string' ? argv3 : ''
}

/**
 * 已安装插件的入口文件候选（profile 目录下的 node_modules 副本）。
 * name 只认包名字符（不许路径分隔符/`..`——它会被拼进路径）；候选两形：`lib/index.js` 与
 * package.json 的 `main`。realpath 由调用方做（这里只给"盘上可能存在的顺序"）。
 */
export function pluginEntryCandidates(profileDir, name) {
	const out = []
	if (typeof profileDir !== 'string' || profileDir.trim() === '') return out
	if (!/^[A-Za-z0-9._@-]+$/.test(String(name || ''))) return out
	const pkgDir = path.join(profileDir, 'node_modules', String(name))
	out.push(path.join(pkgDir, 'lib', 'index.js'))
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
		if (typeof manifest.main === 'string' && manifest.main !== '') out.push(path.join(pkgDir, manifest.main))
	} catch { /* 没有 manifest/main 就只认 lib/index.js */ }
	return [...new Set(out)]
}

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
	// 深度上限 6（11-01 起，原 4）：declarations 的 composition 行挂在第 4 层（body→declarations
	// →行→rows→row→键），4 会把它截成 '[depth-limit]'。封顶语义不变：每层 200 键、数组 200 项、
	// getter 抛错逐键兜住——放宽的只是层数，不是总量。
	if (depth >= 6) return '[depth-limit]'
	// 数组封顶 400（11-01 起，原 200）：loadedPlugins 要摊开全部 loader 条目（本机 213 枚），
	// 200 会把尾部的条目静默截掉。行本身有界（6 字段、字符串各自 slice），键数封顶 200 不变。
	if (Array.isArray(value)) return value.slice(0, 400).map((item) => jsonSafe(item, depth + 1))
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
	// 10-19 新增：建会话那一档要用到的三面（名册／会话所在工作区的归档通道／权限档名册）
	'agentPresets', 'permissionPresets', 'workspaceController',
]

export function apply(ctx) {
	// boot 代次存 **globalThis**（11-01 真机 reload 实测改判：模块级计数器在热重载替换命名空间时
	// 清零回 1，跨不了代；globalThis 与同族的 __backroomObservations 一样跨替换存活）。
	// 探针的 self 格拿它回答"本进程第几代字节"（11-01 痛点 3）。
	globalThis.__backroomApplyGeneration = (globalThis.__backroomApplyGeneration || 0) + 1
	// 观测计数器：端点档读它，CDP 帧也能读 globalThis 上这一枚（与 __chamberObservations 同族约定）。
	const obs = {
		plugin: 'dsh-backroom',
		shape: 'observability',
		appliedAt: new Date().toISOString(),
		routeRegistrations: 0,
		mountErrors: 0,
		lastError: '',
		logLines: 0,
		logDropped: 0,
		consoleLines: 0,
		reentrantSkips: 0,
		rateDropped: 0,
		rateDroppedByTier: { forensic: 0, normal: 0 },
		captureErrors: 0,
		exporterState: 'not-attempted',
		loggerFace: 'unknown',
		bufferLenAtRegister: -1,
		bufferLenNow: -1,
		exporterFirstTsAfterApply: -1,
		consolePatchState: 'not-attempted',
		// 会话窄口的账（每一发放行/拒绝都留痕，拒绝按原因分档计数）
		// owned＝本进程经 /sessions 建出来的那几枚 id；**只有它们**能被本插件自动放行与归档，
		// 你手工开的会话仍然要进 env 名单才动得了（这是"归属"那一格的实物边界）。
		session: { prompts: 0, denied: {}, rateDropped: 0, waits: 0, waitTimeouts: 0, errors: 0, lastPrompt: null,
			created: 0, archived: 0, unarchived: 0, spendTokens: 0, lastSpendReadAt: null, owned: [] },
		// 按插件 reload 的账（11-01 痛点 2）：每一发 touch/证据都留痕。
		reload: { attempts: 0, touched: 0, evidenceHits: 0, noEvidence: 0, errors: 0, rateDropped: 0, denied: {}, last: null },
	}
	globalThis.__backroomObservations = obs

	const ring = createRing(TAIL_LIMIT)
	// 环的**当前**命名空间也要挂 globalThis：自重载时模块整体换新，旧命名空间里的旧环停更，
	// 而 reload 的证据轮询（可能正跑在旧命名空间的那一次调用里）必须能读到新环——
	// 11-01 真机实测：官方行打进了新环，旧环里的轮询等了 8 s 什么都没看见。
	globalThis.__backroomRing = ring
	let inside = false
	// 双档速率闸（11-01 起）：forensic＝error/warn，normal＝info/log/debug。各档独立窗口、
	// 各占满额 RATE_LIMIT——信息洪峰打穿 normal 档时，取证档不被陪葬（11-01 痛点 4 的补偿）。
	const windows = { forensic: { start: Date.now(), count: 0 }, normal: { start: Date.now(), count: 0 } }
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
		const tier = raw.tier === 'forensic' ? 'forensic' : 'normal'
		const win = windows[tier]
		if (now - win.start > RATE_WINDOW_MS) {
			win.start = now
			win.count = 0
		}
		if (win.count >= RATE_LIMIT) {
			obs.rateDropped += 1
			obs.rateDroppedByTier[tier] += 1
			return false
		}
		win.count += 1
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
							const level = typeof message.level === 'number' ? message.level : 1
							const type = String((message && message.type) || LEVEL_NAMES[level] || 'info')
							capture({
								src: 'logger',
								tier: level === 0 || level === 2 || type === 'error' || type === 'warn' ? 'forensic' : 'normal',
								sn: message && typeof message.sn === 'number' ? message.sn : -1,
								ts: message && typeof message.ts === 'number' ? message.ts : Date.now(),
								name: String((message && message.name) || ''),
								type,
								level,
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

	// ── 2) 控制台尾：11-01 用户裁定接**全五枚**（痛点 4：插件 console.log 的诊断行要能进 logs 路由）──
	// 历史：10-04 事故后收窄成 error/warn，理由（热路径开销）的真成因是无界 inspect＋整串正则，
	// 已被逐参数封顶治掉；速率闸改双档（forensic/normal）兜住洪峰。还原也只认自己那枚标记，
	// 绝不踩别人的补丁；重复 apply 不套第二层。
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
					capture({ src: 'console', tier: CONSOLE_TIER_OF[method], sn: -1, ts: Date.now(), name: `console.${method}`, type: method, level: CONSOLE_LEVEL_OF[method], args })
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

		// ── 11-01 痛点 3："当前进程加载的是哪个副本"的通用答案 ──
		// self＝本插件自己的真身（realpath 后的文件 + boot 代次 + 本代 apply 时刻）；
		// loadedPlugins＝从官面 loader.entries() 枚举全部已加载条目，逐枚给
		// baseUrl（loader 解析到的模块 URL）与 realpath（fs.realpathSync 之后＝真在跑的那一份）。
		// 装了两份同名副本时，这一格直接指出运行中的是哪一份——不再需要往 lib 顶部写 LOADED-MARKER。
		// 现场安全性：`loader.entries()` 是纯同步枚举（dsh-plugin-manager 的 @Remote 方法
		// listPlugins 内部就是这么从外层上下文调的，`<dsh-plugin-manager/lib/index.js:1659>`），
		// 不碰 loader 钩子现场；其余全部是属性读取，try/catch 逐枚兜底。
		let selfFace
		try {
			selfFace = {
				face: 'ok',
				name: 'backroom',
				realpath: fs.realpathSync(fileURLToPath(import.meta.url)),
				generation: globalThis.__backroomApplyGeneration || 0,
				appliedAt: obs.appliedAt,
			}
		} catch (error) {
			selfFace = { face: 'threw', message: messageOf(error) }
		}
		const loadedPlugins = (() => {
			try {
				const loader = ctx.get('loader', false)
				if (!loader || typeof loader.entries !== 'function') return { face: loader ? 'no-entries-method' : 'absent', plugins: null, duplicates: null }
				const rows = []
				const byName = new Map()
				// entries() 是迭代器不是数组（11-01 真机实测 .length=undefined）——先收成数组。
				const all = Array.from(loader.entries())
				// 11-01 真机实测：patch `insert` 进来的条目（社区插件的挂法）tree.ctx.baseUrl 是
				// **profile 根**，不是模块文件 ⇒ realpath 会得到误导的目录。此时回退到与 reload
				// 同一套"按名从 profile 解析入口"的路（junction 下 realpath 即真身），并标明来源。
				const profileDir = profileDirOf(process.env.DSH_BACKROOM_PROFILE_DIR, process.argv[3])
				for (const entry of all) {
					if (rows.length >= 400) break
					let baseUrl = null
					try { baseUrl = (entry && entry.parent && entry.parent.tree && entry.parent.tree.ctx && entry.parent.tree.ctx.baseUrl) || null } catch { baseUrl = null }
					const name = entry && entry.options && typeof entry.options.name === 'string' ? entry.options.name : null
					let realpath = null
					let realpathSource = null
					if (typeof baseUrl === 'string' && baseUrl.startsWith('file:') && /\.[cm]?js(?:\?|$)/.test(baseUrl)) {
						try { realpath = fs.realpathSync(fileURLToPath(baseUrl)); realpathSource = 'loader-base' } catch { realpath = 'unresolvable' }
					}
					if (typeof realpath !== 'string' && name && /^[A-Za-z0-9._@-]+$/.test(name)) {
						for (const candidate of pluginEntryCandidates(profileDir, name)) {
							try {
								if (fs.existsSync(candidate)) { realpath = fs.realpathSync(candidate); realpathSource = 'profile-candidate'; break }
							} catch { /* 下一个 */ }
						}
					}
					const row = {
						name,
						entryId: entry && typeof entry.id === 'string' ? entry.id.slice(0, 120) : null,
						enabled: entry ? entry.disabled !== true : null,
						fiberState: entry && entry.fiber ? entry.fiber.state : null,
						baseUrl: typeof baseUrl === 'string' ? baseUrl.slice(0, 300) : null,
						realpath,
						...(realpathSource ? { realpathSource } : {}),
					}
					rows.push(row)
					if (name) {
						if (!byName.has(name)) byName.set(name, new Set())
						if (typeof realpath === 'string') byName.get(name).add(realpath)
					}
				}
				const duplicates = [...byName].filter(([, set]) => set.size > 1).map(([name, set]) => ({ name, copies: [...set] }))
				return { face: 'ok', total: all.length, shown: rows.length, truncated: rows.length < all.length, plugins: rows, duplicates }
			} catch (error) {
				return { face: 'threw', message: messageOf(error).slice(0, 200), plugins: null, duplicates: null }
			}
		})()

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
			self: selfFace,
			loadedPlugins,
			propertyAccess,
			hmr,
			buffer: { len: bufferLen, head: bufferHead },
			services,
			// WSL 桥会用哪枚基址（env > 自家 Host 头观察到 > unknown）。认不到时工具那一发**一个字都不发**，
			// 所以这一格就是"为什么没发"的唯一读数处，别让它只在报错里出现。
			bridge: bridgeBase(process.env.DSH_BACKROOM_BRIDGE_BASE, selfOrigin),
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
			// level 允许两种写法：数值档（0..3，官面 LoggerLevel）或名字（error/info/warn/debug，
			// 11-01 起再加 `log`——console.log 那一路的 type 就是方法名本身）。
			const raw = query.level === undefined ? '' : String(query.level)
			let levelName = null
			if (raw !== '') {
				levelName = LEVEL_NAMES[raw] || (Object.values(LEVEL_FILTER_NAMES).includes(raw) ? raw : null)
				if (levelName === null) return sendJson(res, 400, { ok: false, reason: 'bad-level', allowed: Object.values(LEVEL_FILTER_NAMES) })
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
	// key 三种递法都收（10-19 尾部：其他 agent 反馈"两个动手端点仍回 no-key"——实物是他们按 header 递、
	// 而当时只认 ?key=，于是对的 key 也落成 no-key）。查询串/头/Bearer 任意一种即可。
	const keyMaterial = (req, query) => {
		if (typeof query.key === 'string' && query.key !== '') return query.key
		const h = req && req.headers && typeof req.headers === 'object' ? req.headers : {}
		const headerKey = h['x-backroom-key']
		if (typeof headerKey === 'string' && headerKey !== '') return headerKey
		const auth = typeof h.authorization === 'string' ? h.authorization : ''
		const bearer = /^Bearer\s+(.+)$/i.exec(auth)
		return bearer ? bearer[1].trim() : ''
	}
	// 提示里必须给出"去哪拿"——只写"有个 env"等于让下一个人继续猜（这正是本轮反馈的形状）
	const keyHint = () => {
		const file = process.env.DSH_BACKROOM_KEY_FILE
		const how = '必带 key：?key=<k>，或请求头 x-backroom-key: <k>，或 Authorization: Bearer <k>（三选一）。'
		const where = typeof file === 'string' && file !== ''
			? `本机这把 key 的落点＝${file}（启动器写的；同一份也在 dsh 进程的环境变量 DSH_BACKROOM_SESSION_KEY 里）。读不到就重跑启动器。`
			: 'key 在启动 dsh 那一发的环境变量 DSH_BACKROOM_SESSION_KEY 里；启动器会把它打印出来。要一个可读的落点：启动器加 -KeyFile <路径>。'
		return how + where
	}
	const keyVerdict = (given) => {
		const want = process.env.DSH_BACKROOM_SESSION_KEY
		if (typeof want !== 'string' || want === '') return 'disabled'
		if (typeof given !== 'string' || given === '') return 'no-key'
		const a = Buffer.from(given, 'utf8')
		const b = Buffer.from(want, 'utf8')
		if (a.length !== b.length) return 'bad-key'
		try { return crypto.timingSafeEqual(a, b) ? 'ok' : 'bad-key' } catch { return 'bad-key' }
	}
	// 闸 3：只认登记过的 sessionId，**或**本进程刚经 /sessions 建出来的那一枚（owned）。
	// 绝不"挑最近一枚"；owned 之外的一律要 env 名单——这是"我造的才准我自动放行、也才准我归档"的实物边界。
	const ownedIds = new Set()
	const allowListIds = () => {
		const raw = process.env.DSH_BACKROOM_SESSION_ALLOW
		if (typeof raw !== 'string' || raw.trim() === '') return []
		return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
	}
	const allowVerdict = (sessionId) => {
		if (typeof sessionId !== 'string' || sessionId === '') return 'no-session'
		if (ownedIds.has(sessionId)) return 'ok'
		if (allowListIds().length === 0) return 'no-allowlist'
		return allowListIds().includes(sessionId) ? 'ok' : 'not-allowlisted'
	}
	// 闸 4：速率（一分钟窗口内超额直接 429，并计数）
	const rateVerdict = () => {
		const now = Date.now()
		sess.stamps = (sess.stamps || []).filter((t) => now - t < SESSION_RATE_WINDOW_MS)
		if (sess.stamps.length >= SESSION_RATE_LIMIT) return 'rate-limited'
		sess.stamps.push(now)
		return 'ok'
	}
	const readBody = (req, limit = SESSION_BODY_LIMIT) => new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return }
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
				// 预算闸与档位闸的读数都从同一袋里取，**不额外多打一发官面调用**（view 形状现读自打包码：
				// tokenUsage→state.totals 四枚桶；permissions→{currentValue}；agentPreset→字符串；title→字符串|null）
				spendTokens: tokenSpend(values.tokenUsage),
				permissionPreset: values.permissions && typeof values.permissions === 'object' && typeof values.permissions.currentValue === 'string' ? values.permissions.currentValue : null,
				agentPreset: typeof values.agentPreset === 'string' ? values.agentPreset : (values.agentPreset === null ? null : 'absent'),
				title: typeof values.title === 'string' ? values.title : null,
				projectionKeys: Object.keys(values).slice(0, 40),
				readable: typeof turnCount === 'number',
			}
		} catch (error) { return { face: 'threw', message: messageOf(error).slice(0, 200) } }
	}

	const sessionHandler = async (req, res) => {
		try {
			const query = queryOf(req.url || '')
			const verdict = keyVerdict(keyMaterial(req, query))
			if (verdict !== 'ok') {
				return sendJson(res, 403, { ok: false, reason: deny(verdict), hint: '窄口默认关（env DSH_BACKROOM_SESSION_KEY＋ALLOW 才放行）。' + keyHint() })
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
			// 档位：官面 `session/prompt` 的 jsonSchema 里 `mode` 是 `["queue","steer"]`（打包码逐字现读），
			// 不带这一格时行为照旧＝queue。
			const mode = query.mode === undefined || query.mode === '' ? 'queue' : String(query.mode)
			if (mode !== 'queue' && mode !== 'steer') return sendJson(res, 400, { ok: false, reason: deny('bad-mode'), allowed: ['queue', 'steer'] })
			// 档位闸：会话实际生效的权限档（`permissions` 投影 currentValue）命中**显式点名的**禁止名单才拦。
			// 默认名单为空（见 denyGate 上面那段：拦官面默认档＝新建会话全废），而"放宽"这一手本插件结构上做不到。
			// ⚠ 只有"读到了、且在读的这枚值被禁"才拦路：`permissions` 投影在会话还没 seed 时本就是 null，
			//   把"我没读到"当成"它危险"是**沉默假阴性**那一族（10-19 刚在端口那格栽过一次），所以 unknown 只报不拦。
			const presetGateVerdict = denyGate(before.permissionPreset, process.env.DSH_BACKROOM_DENY_PRESETS)
			if (presetGateVerdict === 'denied-preset') {
				return sendJson(res, 403, {
					ok: false, reason: deny('denied-preset'), sessionId,
					permissionPreset: before.permissionPreset,
					hint: '这枚会话的权限档在你点名的禁止名单里。名单默认是空的（要放开就清掉 DSH_BACKROOM_DENY_PRESETS）；本插件绝不代改权限档——它没有那一枚调用（哨兵禁 set）。',
				})
			}
			// 预算闸：只对**本插件建的**会话生效——你手工开的会话，花费本来就在流里，插件不是它的账房。
			if (ownedIds.has(sessionId)) {
				const limit = Number(process.env.DSH_BACKROOM_TOKEN_BUDGET) || SESSION_BUDGET_TOKENS_PER_HOUR
				const spent = typeof before.spendTokens === 'number' ? before.spendTokens : 0
				if (limit > 0 && spent >= limit) return sendJson(res, 403, {
					ok: false, reason: deny('budget-exceeded'), sessionId, spentTokens: spent, limitTokens: limit,
					note: '标度来源＝本窗实测 14,920 token/回合 ⇒ 默认 60,000≈4 回合；抬它请设 DSH_BACKROOM_TOKEN_BUDGET=<tokens> 并带上你的新实测数',
				})
			}
			const requestId = crypto.randomUUID()
			let admitted
			try {
				// 第二枚参数是官面 handler 要的取消信号（10-05 实测：不带它 ⇒ 在解析会话那一步
				// 撞 `Cannot read properties of undefined (reading 'throwIfAborted')`，看着像"会话不存在"，其实是我们少传了参数）
				admitted = await sc.prompt({ sessionId, requestId, mode, content: [{ type: 'text', text }] }, new AbortController().signal)
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
			sess.lastPrompt = { sessionId, requestId, at: new Date().toISOString(), mode }
			const base = { ok: true, sessionId, requestId, mode, accepted: Boolean(admitted && admitted.accepted === true), permissionGate: presetGateVerdict, before }
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

	// ── 5b) 预设名册（只读，不要 key）：建会话那一档的靶单**必须运行时读** ──────────
	// 名额闸建在这里（presetsHandler 要报"还剩几个名额"，所以它得先存在）
	const createQuota = hourWindow(Number(process.env.DSH_BACKROOM_MAX_SESSIONS_PER_HOUR) || SESSION_CREATE_LIMIT_PER_HOUR)
	// 为什么不写死档位名：装机文案逐字写着"关闭代码工作工具时提供标准、创造、自定义；开启后还提供
	// PTC 和极简"，名册随订阅开关变；`agentPresets.list()` 连激活失败的那一枚都带 `broken` 字段回。
	const readRoster = async () => {
		const ap = ctx.get('agentPresets', false)
		if (!ap || typeof ap.list !== 'function') return { face: ap ? 'no-list-method' : 'absent', presets: null, defaultId: null }
		try {
			const rows = await ap.list()
			const presets = (Array.isArray(rows) ? rows : []).filter((x) => x && typeof x.id === 'string').map((x) => ({
				id: x.id,
				...(typeof x.name === 'string' ? { name: x.name } : {}),
				...(typeof x.description === 'string' ? { description: x.description.slice(0, 160) } : {}),
				...(typeof x.order === 'number' ? { order: x.order } : {}),
				...(typeof x.broken === 'string' ? { broken: x.broken.slice(0, 160) } : {}),
			}))
			let defaultId = null
			try { if (typeof ap.defaultId === 'string') defaultId = ap.defaultId } catch { /* 取不到就 null，不猜 */ }
			return { face: 'ok', presets, defaultId }
		} catch (error) {
			return { face: 'threw', message: messageOf(error).slice(0, 200), presets: null, defaultId: null }
		}
	}
	const presetsHandler = async (req, res) => {
		try {
			const roster = await readRoster()
			const pp = ctx.get('permissionPresets', false)
			const permissions = { face: pp ? (typeof pp.catalog === 'function' ? 'ok' : 'no-catalog-method') : 'absent', names: null, defaultPreset: null, options: null }
			if (pp && permissions.face === 'ok') {
				try { if (Array.isArray(pp.names)) permissions.names = pp.names.slice(0, 40) } catch { /* 保持 null */ }
				try {
					const catalog = pp.catalog()
					if (catalog && typeof catalog === 'object') {
						permissions.defaultPreset = typeof catalog.defaultPreset === 'string' ? catalog.defaultPreset : null
						permissions.options = Array.isArray(catalog.options) ? catalog.options.slice(0, 40).map((o) => ({ value: String(o.value), ...(typeof o.name === 'string' ? { name: o.name } : {}) })) : null
					}
				} catch { permissions.catalogError = 'threw' }
			}
			sendJson(res, 200, {
				ok: true,
				tier: '只读档（本端点不建会话、不改档位、不发消息）',
				// 发现性那一半：其他 agent 拿到名册时也顺手拿到"两枚动手端点怎么带 key、key 在哪"，
				// 而不是自己猜一个参数名然后吃 no-key（10-19 尾部反馈的形状）。
				auth: {
					schemes: ['?key=<k>', 'header x-backroom-key: <k>', 'header Authorization: Bearer <k>'],
					envName: 'DSH_BACKROOM_SESSION_KEY',
					keyFile: process.env.DSH_BACKROOM_KEY_FILE || null,
					hint: keyHint(),
				},
				agentPresets: roster,
				permissionPresets: permissions,
				// 这一句是给"新建会话会落在哪一档"的显式提醒：本机实测 defaultPreset 就是最宽那一档，
				// 而本插件不改档位（也做不到改）——看得见比偷偷拦有用。
				permissionWarning: permissions.defaultPreset === 'danger-full-access'
					? '注意：这台机器的官面默认权限档是 `danger-full-access`（最宽那一档）。本插件新建的会话会落在这一档，且**不会**去改它；要换档请你在界面上选，或设 DSH_BACKROOM_DENY_PRESETS=danger-full-access 让插件拒绝往里发消息。'
					: null,
				gates: {
					createRoots: process.env.DSH_BACKROOM_WORKSPACE_ROOTS ? 'set' : 'unset=建会话 disabled',
					allowPresets: process.env.DSH_BACKROOM_ALLOW_PRESETS || '(未设＝名册即白名单)',
					denyPresets: process.env.DSH_BACKROOM_DENY_PRESETS === undefined ? '(未设＝空名单：不拦，档位只逐发回显)' : (process.env.DSH_BACKROOM_DENY_PRESETS.trim() === '' ? '(显式清空＝不拦)' : process.env.DSH_BACKROOM_DENY_PRESETS),
					maxSessionsPerHour: createQuota.peek().limit || SESSION_CREATE_LIMIT_PER_HOUR,
					tokenBudget: Number(process.env.DSH_BACKROOM_TOKEN_BUDGET) || SESSION_BUDGET_TOKENS_PER_HOUR,
				},
				next: '建一枚：POST /dsh-backroom/sessions?key=… body {"cwd":"<白名单内的目录>","agentPreset":"<名册里的 id>","caller":"<谁>"}；收回去 body {"op":"archive","sessionId":"<刚那枚>"}（只准收本插件建的）',
			})
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error).slice(0, 300) })
		}
	}

	// ── 5b-2) 声明档（只读，不要 key）：把官面名册的"声明体内文"摊开（11-01 痛点 1）──────────
	// 为什么要有：presets 路由只给 roster 名单（id/name/order/broken），看不到每枚声明交给宿主的
	// `plugins` composition 行 ⇒ 验证插件物化出的变体（如 wsl-*）时只能给已装 lib 打临时 dump
	// 探针＋重启（2026-11-01 会话一个验证循环碰了 4 次宿主）。asar 现读：官面 registry 自带两枚
	// 只读面正好补这一格——
	//   · `readDocument(id)`＝@Remote("read")（浏览器在看的那一路）：`record.config.plugins` 的
	//     YAML dump，纯对象读（<dsh-agent-preset-registry/lib/index.js:613-631>）；
	//   · `compositionInventory()`＝"Read plugin rows without creating an Agent"：逐枚声明回
	//     `rows`（声明行或 mount 树条目，含 enabled/fiberState）（同文件 :791-807）。
	// 两枚都不进 loader 现场（对照 10-04 `getLinked` 那发拖死）且都是纯读；`diagnostic()` 的
	// await 路径与生产里的 `list()` 完全同路。哪枚面在这版宿主上缺席就如实报 absent，不猜形状。
	const declarationsHandler = async (req, res) => {
		try {
			const ap = ctx.get('agentPresets', false)
			const roster = await readRoster()
			let invFace = ap && typeof ap.compositionInventory === 'function' ? 'ok' : (ap ? 'no-compositionInventory-method' : 'absent')
			let inv = null
			if (invFace === 'ok') {
				try {
					const rows = await ap.compositionInventory()
					inv = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]))
				} catch (error) { invFace = `threw: ${messageOf(error).slice(0, 160)}` }
			}
			const docFace = ap && typeof ap.readDocument === 'function' ? 'ok' : (ap ? 'no-readDocument-method' : 'absent')
			const declarations = []
			for (const row of roster.presets || []) {
				const item = {
					id: row.id,
					...(row.name ? { name: row.name } : {}),
					...(row.description ? { description: row.description } : {}),
					...(row.order !== undefined ? { order: row.order } : {}),
					...(row.broken ? { broken: row.broken } : {}),
				}
				const inInv = inv && inv.get(row.id)
				if (inInv) {
					item.isDefault = inInv.isDefault === true
					item.rows = Array.isArray(inInv.rows) ? inInv.rows : []
				} else if (invFace === 'ok') {
					item.rows = null
					item.rowsFace = 'absent-in-inventory'
				}
				if (docFace === 'ok') {
					try {
						const doc = await ap.readDocument(row.id)
						item.content = doc && typeof doc.content === 'string' ? doc.content.slice(0, 20_000) : null
						if (!item.content) item.contentFace = 'empty-or-missing'
					} catch (error) {
						item.content = null
						item.contentFace = `threw: ${messageOf(error).slice(0, 160)}`
					}
				} else {
					item.content = null
					item.contentFace = docFace === 'absent' ? 'absent（这版宿主的 agentPresets 没有 readDocument）' : docFace
				}
				declarations.push(item)
			}
			sendJson(res, 200, {
				ok: true,
				tier: '只读档（只调官面只读面：list / compositionInventory / readDocument(@Remote "read")；不写盘、不建会话、不碰 loader 现场）',
				face: roster.face,
				defaultId: roster.defaultId,
				faces: { compositionInventory: invFace, readDocument: docFace },
				declarations,
				note: 'rows＝解析后的 composition 行（entryId/moduleName/enabled/condition?/fiberState?）；content＝声明体 plugins 的 YAML 原文。变体验证（wsl-* 等）看这里，不必再给插件 lib 打 dump 探针。',
			})
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error).slice(0, 300) })
		}
	}

	// ── 5c) 建会话／收回去（10-19 用户改判「不需要切换模型，其他做完」）───────────────
	// 六把闸逐把过，顺序＝先花小钱前先卡大的：key → 名额 → 范围 → 名册 → 预算 → 档位，最后才动官面。
	// 本插件**从不**改权限档、**从不**切模型、**从不**碰不是自己造的会话。
	const readOwnedSpend = async () => {
		let sum = 0
		for (const id of [...ownedIds].slice(0, 20)) {
			const face = await readTurnFace(id)
			if (typeof face.spendTokens === 'number') sum += face.spendTokens
		}
		obs.session.spendTokens = sum
		obs.session.lastSpendReadAt = new Date().toISOString()
		return sum
	}
	const sessionsHandler = async (req, res) => {
		try {
			const query = queryOf(req.url || '')
			const verdict = keyVerdict(keyMaterial(req, query))
			if (verdict !== 'ok') return sendJson(res, 403, { ok: false, reason: deny(verdict), hint: '这一枚端点会建会话/归档会话，必须带 key。' + keyHint() })
			if (req.method === 'GET') {
				// 账要先刷再报：`obs.session.spendTokens` 只在 create 时算过一次，直接回会给出一个**旧的 0**
				// （真宿主实测：建完发过一问之后账本仍回 0，而同一枚会话单读是 14k 级——10-19 抓到）
				await readOwnedSpend()
				return sendJson(res, 200, {
					ok: true, tier: '只读账（本进程建过什么、花了多少、还剩多少名额）',
					owned: obs.session.owned, spendTokens: obs.session.spendTokens, lastSpendReadAt: obs.session.lastSpendReadAt,
					quota: createQuota.peek(), budgetTokens: Number(process.env.DSH_BACKROOM_TOKEN_BUDGET) || SESSION_BUDGET_TOKENS_PER_HOUR,
					note: 'owned＝只有本进程经这枚端点建的会话；你手工开的会话不在里面，本插件也动不了它',
				})
			}
			if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
			let payload
			try { payload = JSON.parse((await readBody(req, SESSION_CREATE_BODY_LIMIT)) || '{}') } catch (error) {
				const reason = messageOf(error) === 'body-too-large' ? 'body-too-large' : 'bad-json'
				return sendJson(res, 400, { ok: false, reason: deny(reason) })
			}
			const op = typeof payload.op === 'string' ? payload.op : 'create'
			const sc = ctx.get('sessionController', false)
			if (!sc) return sendJson(res, 200, { ok: false, reason: 'no-sessionController' })
			// 回收档：归档/取消归档**只准对本进程建的那几枚**，且用官面通道（不碰盘、不写 profile）
			if (op === 'archive' || op === 'unarchive') {
				const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
				if (!ownedIds.has(sessionId)) return sendJson(res, 403, { ok: false, reason: deny('not-owned'), hint: '本插件只准收自己建的会话；你的会话请自己在界面上归档' })
				const wc = ctx.get('workspaceController', false)
				const method = op === 'archive' ? 'archiveSession' : 'unarchiveSession'
				if (!wc || typeof wc[method] !== 'function') return sendJson(res, 200, { ok: false, reason: `no-workspaceController.${method}` })
				let out
				try { out = await wc[method]({ sessionId }) } catch (error) {
					sess.errors += 1
					return sendJson(res, 502, { ok: false, stage: method, reason: (error && error.code) || (error && error.name) || 'threw', message: messageOf(error).slice(0, 240) })
				}
				if (op === 'archive') { ownedIds.delete(sessionId); obs.session.archived += 1 } else { ownedIds.add(sessionId); obs.session.unarchived += 1 }
				obs.session.owned = [...ownedIds]
				// 官面这一发回的是**整个归档集**（真宿主实测 12 枚，含用户早就归档好的 11 枚），
				// 所以必须自己算出"你刚收的那一枚在不在里面"，别让人把那串当成"我归档了 12 枚"。
				// 两种形状都吃：Remote 直回 `{archivedSessionIds}`；套了信封的那层是 `{ok,value:{...}}`。
				const setAfter = Array.isArray(out && out.archivedSessionIds) ? out.archivedSessionIds
					: Array.isArray(out && out.value && out.value.archivedSessionIds) ? out.value.archivedSessionIds : null
				return sendJson(res, 200, {
					ok: true, op, sessionId, value: jsonSafe(out),
					archivedNow: op === 'archive' && setAfter !== null ? setAfter.includes(sessionId) : null,
					unarchivedNow: op === 'unarchive' && setAfter !== null ? !setAfter.includes(sessionId) : null,
					archivedSetSize: setAfter === null ? null : setAfter.length,
					note: op === 'archive' ? '官面原句＝Hide one known Session from Workspace grouping surfaces ⇒ 这是**从分组面摘掉**，不是删除；盘上残留（sessions/ 树、projcache、attachments）本插件不动，也不冒充"已清干净"。`archivedSetSize` 是整个归档集的大小，不是本次动作的条数' : '已恢复到分组面；它仍在本插件的 owned 名单里',
				})
			}
			if (op !== 'create') return sendJson(res, 400, { ok: false, reason: deny('bad-op'), allowed: ['create', 'archive', 'unarchive'] })
			// 闸 A 名额
			const quota = createQuota.take()
			if (!quota.ok) {
				return sendJson(res, 429, { ok: false, reason: deny('quota-exceeded'), used: quota.used, limit: quota.limit, hint: '要更多名额：DSH_BACKROOM_MAX_SESSIONS_PER_HOUR=<n>（默认 3，理由＝每建一枚都在你 profile 里长一份资产，而归档只是隐藏）' })
			}
			// 闸 B 范围：**cwd 或 workspaceId 二选一**（官面 create 里这两个字段互斥）。
			//   · cwd：目录由这枚会话自己拥有，不加入任何工作区；
			//   · workspaceId：会话加入一个已存在的工作区 —— "绑定/解除绑定"那类测试要的是这一支
			//     （#129 的端到端就是它；只给 cwd 建出来的会话没有 workspace 归属，测不了那一格）。
			// 两条都要过同一把 rootGate：**先取到它的路径再判白名单**，绝不因为"它已在工作区列表里"就放行。
			const roots = process.env.DSH_BACKROOM_WORKSPACE_ROOTS
			const rawCwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? path.resolve(payload.cwd) : ''
			const rawWs = typeof payload.workspaceId === 'string' && payload.workspaceId !== '' ? payload.workspaceId : ''
			if (rawCwd !== '' && rawWs !== '') {
				return sendJson(res, 400, { ok: false, reason: deny('cwd-and-workspace-id'), hint: '官面 create 里 cwd 与 workspaceId 互斥，二选一' })
			}
			if (rawCwd === '' && rawWs === '') {
				return sendJson(res, 400, { ok: false, reason: deny('no-cwd'), hint: '给 cwd（目录由这枚会话自己拥有）或 workspaceId（加入一个已存在的工作区）' })
			}
			let targetPath = toPosix(rawCwd)
			let wsView = null
			let wr = null
			let wsSessionIdsBefore = null
			if (rawWs !== '') {
				wr = ctx.get('workspaceRegistry', false)
				if (!wr) return sendJson(res, 502, { ok: false, reason: deny('no-workspaceRegistry'), hint: '这枚实例取不到 workspaceRegistry ⇒ 不能按 workspaceId 建' })
				try { if (typeof wr.get === 'function') wsView = await wr.get(rawWs) } catch { wsView = null }
				if (!wsView && typeof wr.list === 'function') {
					try {
						const all = await wr.list()
						wsView = (Array.isArray(all) ? all : []).find((w) => w && w.workspaceId === rawWs) || null
					} catch { wsView = null }
				}
				if (!wsView) {
					createQuota.undo()
					return sendJson(res, 404, { ok: false, reason: deny('workspace-not-found'), workspaceId: rawWs, hint: '先用 GET /dsh-backroom/presets? 或官面工作区列表确认 id；本插件不替你建工作区（那是 backroom_workspace 工具的事）' })
				}
				targetPath = typeof wsView.path === 'string' ? toPosix(wsView.path) : ''
				if (targetPath === '') {
					createQuota.undo()
					return sendJson(res, 502, { ok: false, reason: deny('workspace-without-path'), workspaceId: rawWs, view: jsonSafe(wsView) })
				}
				// 快照：官面 create 可能"会话先落盘、attach 才失败"（10-30 实测：路径大小写不一致时就是这一形），
				// 那一枚会话不在我们的 owned 账里 ⇒ 失败回包要自己把它算出来交回去，否则用户侧栏里多一枚无人认领的。
				if (Array.isArray(wsView.sessionIds)) wsSessionIdsBefore = new Set(wsView.sessionIds)
			}
			const rootVerdict = rootGate(roots, targetPath)
			if (rootVerdict !== 'ok') {
				createQuota.undo()
				return sendJson(res, 403, {
					ok: false,
					reason: deny(rootVerdict === 'disabled' ? 'no-create-roots' : 'cwd-outside-roots'),
					...(rawWs !== '' ? { workspaceId: rawWs, workspacePath: targetPath } : { cwd: targetPath }),
					allowed: (roots || '').split(/[;,]/).filter(Boolean),
					hint: '没设 DSH_BACKROOM_WORKSPACE_ROOTS＝建会话整格 disabled（与建工作区同一把闸）；workspaceId 也按它那条路径判白名单',
				})
			}
			// 闸 C 名册：预设必须当场在名册里；没点就用官面 defaultId，并把这一格如实报出来
			const roster = await readRoster()
			const wanted = typeof payload.agentPreset === 'string' && payload.agentPreset !== '' ? payload.agentPreset : null
			if (roster.presets === null) return sendJson(res, 502, { ok: false, reason: deny('roster-unavailable'), roster: roster.face, hint: '读不到官面名册就不能建（不许"猜一个档位名"送进你的会话）' })
			const presetVerdict = wanted === null ? 'ok' : presetGate(roster.presets, wanted, process.env.DSH_BACKROOM_ALLOW_PRESETS)
			if (presetVerdict !== 'ok') {
				createQuota.undo()
				return sendJson(res, 403, { ok: false, reason: deny(presetVerdict), wanted, roster: roster.presets.map((p) => p.id), allowList: process.env.DSH_BACKROOM_ALLOW_PRESETS || null })
			}
			// 闸 D 预算：本插件已建会话的累计 token（读官面 tokenUsage 投影的 totals）
			const limitTokens = Number(process.env.DSH_BACKROOM_TOKEN_BUDGET) || SESSION_BUDGET_TOKENS_PER_HOUR
			const spent = await readOwnedSpend()
			const bgate = budgetGate(spent, limitTokens)
			if (bgate.verdict === 'budget-exceeded') {
				createQuota.undo()
				return sendJson(res, 403, { ok: false, reason: deny('budget-exceeded'), spentTokens: spent, limitTokens, note: '标度来源＝本窗实测 14,920 token/回合 ⇒ 默认 60,000≈4 回合；抬它请带新的实测数' })
			}
			// 官面创建：create(request)，request＝{cwd | workspaceId, agentPreset?}（形状现读自打包码 SessionCreateRequest）
			let created
			try { created = await sc.create({ ...(wanted === null ? {} : { agentPreset: wanted }), ...(rawWs !== '' ? { workspaceId: rawWs } : { cwd: toPosix(rawCwd) }) }) } catch (error) {
				sess.errors += 1
				createQuota.undo()
				// "created but could not attach" 那一形：会话已落盘、attach 失败 ⇒ 它不在 owned 账里。
				// 这里按"工作区 sessionIds 的差集"把它找出来交回给调用方（找不到就如实写 null）。
				let orphanSessionId = null
				if (rawWs !== '' && wr && wsSessionIdsBefore && typeof wr.get === 'function') {
					try {
						const again = await wr.get(rawWs)
						const after = again && Array.isArray(again.sessionIds) ? again.sessionIds : []
						orphanSessionId = after.find((id) => typeof id === 'string' && !wsSessionIdsBefore.has(id)) || null
					} catch { orphanSessionId = null }
				}
				return sendJson(res, 502, {
					ok: false, stage: 'create', reason: (error && error.code) || (error && error.name) || 'threw', message: messageOf(error).slice(0, 300),
					...(orphanSessionId === null ? {} : { orphanSessionId }),
					hint: orphanSessionId === null
						? '官面 create 拒了这一发；没有发现新落盘的会话'
						: '官面 create 很可能**已经建出会话**但没挂上工作区（orphanSessionId 就是它）：它不在本插件的 owned 账里，本插件也不会替你归档；请在侧栏/工作区里手动处理，或按 id 自己调官面 archiveSession',
				})
			}
			const sessionId = created && typeof created.sessionId === 'string' ? created.sessionId : ''
			if (sessionId === '') return sendJson(res, 502, { ok: false, reason: deny('create-returned-no-id'), value: jsonSafe(created) })
			ownedIds.add(sessionId)
			obs.session.created += 1
			obs.session.owned = [...ownedIds]
			// 归属标记：标题带上调用方，让你在侧栏一眼认出是谁造的（失败如实报，不假装成功）
			const marker = callerMarker(payload.caller)
			let titleState = { attempted: false, ok: false, reason: 'no-caller' }
			if (marker.ok && typeof sc.rename === 'function') {
				try { await sc.rename({ sessionId, title: marker.title }); titleState = { attempted: true, ok: true, title: marker.title } } catch (error) {
					titleState = { attempted: true, ok: false, reason: (error && error.code) || messageOf(error).slice(0, 120) }
				}
			} else if (marker.ok) titleState = { attempted: false, ok: false, reason: 'no-rename-method' }
			const face = await readTurnFace(sessionId)
			// 把"这台机器新建会话默认落在哪一档"一起回出去（现读 catalog，不改任何东西）
			let officialDefaultPermission = null
			try {
				const pp = ctx.get('permissionPresets', false)
				if (pp && typeof pp.catalog === 'function') {
					const catalog = pp.catalog()
					if (catalog && typeof catalog.defaultPreset === 'string') officialDefaultPermission = catalog.defaultPreset
				}
			} catch { /* 读不到就留 null，不猜 */ }
			sendJson(res, 200, {
				ok: true, op: 'create', sessionId,
				joinedWorkspaceId: rawWs === '' ? null : rawWs,
				joinedWorkspacePath: rawWs === '' ? null : targetPath,
				ownedCwd: rawWs === '' ? toPosix(rawCwd) : null,
				agentPreset: created.agentPreset ?? face.agentPreset ?? (wanted ?? 'official-default'),
				officialDefaultPreset: roster.defaultId, requestedPreset: wanted,
				permissionPreset: face.permissionPreset ?? null, officialDefaultPermission, permissionGate: denyGate(face.permissionPreset, process.env.DSH_BACKROOM_DENY_PRESETS), title: face.title ?? null,
				spendTokens: face.spendTokens ?? null, quota: createQuota.peek(), budgetTokens: limitTokens, spentTokens: spent,
				titleState,
				note: (rawWs !== ''
					? '这一步只**建**了会话并让它加入工作区 ' + rawWs + '（档位来自官面名册），一个字的消息都没发；'
					: '这一步只**建**了会话（cwd 由它自己拥有，档位来自官面名册），一个字的消息都没发；')
					+ '要发：POST /dsh-backroom/session?key=…&session=' + sessionId + '&wait=turn-end（本插件建的会话自动在名单里，不用改 env）',
				archive: '收回去：POST /dsh-backroom/sessions?key=… body {"op":"archive","sessionId":"' + sessionId + '"}（官面 archiveSession＝从分组面摘掉，**不是删除**；盘上残留本插件不动）',
			})
		} catch (error) {
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error).slice(0, 300) })
		}
	}

	// ── 5d) 按插件定向 reload（动作档，key 门内；11-01 痛点 2）────────────────────────
	// asar 现读改了提案的机制：dsh-hmr **没有**"按名重载"的公开 API——`runReload(operation)` 只是
	// 把一枚操作排进 reload 队列的串行器（`<dsh-hmr/lib/index.js:757-761>`），真正的模块替换只由
	// "监听根内文件变更 → stash → partialReload"（同文件 :883-932、:1015）驱动 ⇒ 包装 runReload
	// 触发不了任何重载。所以本端点的机制＝**碰一下目标插件已加载入口文件的 mtime**
	// （`fs.utimesSync`：全仓唯一的"写"面，且只写元数据不碰内容——等效于"用户在编辑器里存了一次盘"），
	// 其余全部走官方 watcher 路径；本端点**不调用 hmr 的任何方法**（getLinked/watchConfig/runExclusive/
	// runReload 哨兵照旧全禁），对 hmr 只读 `config`/`baseDir` 两个属性来判"watcher 盖不盖得住"。
	// 证据＝官方重载完成后打的 logger 行 `reload plugin at %C`（:1120），从自家捕获环里捞；
	// 等不到就如实报 evidence.found=false 并给出自证路（GET /probe 的 self.generation／appliedAt），
	// 绝不假装成功。前置（用户 11-01 已点头）：活 profile 补丁给 hmr 配 base/root、插件以 junction
	// 形态安装——两条都在 RULES §H.6.3 的开发回路里。
	const RELOAD_RATE_LIMIT = 6
	const RELOAD_RATE_WINDOW_MS = 60_000
	const RELOAD_WAIT_DEFAULT_MS = 8_000
	const RELOAD_WAIT_MAX_MS = 30_000
	const RELOAD_POLL_MS = 250
	const reloadStamps = []
	const denyReload = (reason) => { obs.reload.denied[reason] = (obs.reload.denied[reason] || 0) + 1; return reason }
	/** watcher 盖到哪：只读 hmr 的 config/baseDir 属性，绝不调方法。covered 留给 rootGate 判。 */
	const readWatchState = (hmr) => {
		try {
			const cfg = hmr.config
			const baseDir = typeof hmr.baseDir === 'string' ? hmr.baseDir : ''
			if (!cfg || !Array.isArray(cfg.root)) return { face: 'unknown-config', covered: false }
			if (cfg.root.length === 0 || baseDir === '') return { face: 'watching-nothing', covered: false, baseDir: baseDir || null, root: cfg.root }
			const baseReal = toPosix(fs.realpathSync(baseDir))
			const roots = cfg.root.map((r) => toPosix(path.resolve(baseReal, String(r))))
			return { face: 'ok', baseDir: baseReal, root: cfg.root, roots }
		} catch (error) {
			return { face: `threw: ${messageOf(error).slice(0, 160)}`, covered: false }
		}
	}
	const reloadHandler = async (req, res) => {
		try {
			if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
			const query = queryOf(req.url || '')
			const verdict = keyVerdict(keyMaterial(req, query))
			if (verdict !== 'ok') return sendJson(res, 403, { ok: false, reason: denyReload(verdict), hint: '这一枚端点会触发官方热重载，必须带 key。' + keyHint() })
			const now = Date.now()
			while (reloadStamps.length > 0 && now - reloadStamps[0] >= RELOAD_RATE_WINDOW_MS) reloadStamps.shift()
			if (reloadStamps.length >= RELOAD_RATE_LIMIT) { obs.reload.rateDropped += 1; return sendJson(res, 429, { ok: false, reason: denyReload('rate-limited'), limit: RELOAD_RATE_LIMIT, windowMs: RELOAD_RATE_WINDOW_MS }) }
			reloadStamps.push(now)
			obs.reload.attempts += 1
			const name = typeof query.plugin === 'string' ? query.plugin.trim() : ''
			if (!/^[A-Za-z0-9._@-]+$/.test(name)) return sendJson(res, 400, { ok: false, reason: denyReload('bad-plugin-name'), hint: 'plugin=<包名>；不许带路径分隔符或 ..' })
			const hmr = ctx.get('hmr', false)
			if (!hmr) return sendJson(res, 200, { ok: false, reason: 'no-hmr', hint: '这枚 profile 没有 hmr 服务（无头档就没有）⇒ 免重载不可用，改走重启。' })
			const watch = readWatchState(hmr)
			// 目标＝真在跑的那一份：候选（package.json main 与 lib/index.js）里第一个存在者，realpath 之后
			// 才是"运行中的副本"——两份同名副本时这里解析到哪份就是哪份（同痛点 3 的口径）。
			const candidates = pluginEntryCandidates(profileDirOf(process.env.DSH_BACKROOM_PROFILE_DIR, process.argv[3]), name)
			let target = null
			for (const candidate of candidates) {
				try { if (fs.existsSync(candidate)) { target = fs.realpathSync(candidate); break } } catch { /* 下一个 */ }
			}
			if (!target) return sendJson(res, 404, { ok: false, reason: denyReload('entry-not-found'), plugin: name, tried: candidates, hint: 'profile 目录（process.argv[3]）的 node_modules 里没找到这枚包的入口；它可能不装在本 profile' })
			const coverVerdict = watch.face === 'ok' && Array.isArray(watch.roots) ? rootGate(watch.roots.join(';'), target) : 'disabled'
			if (coverVerdict !== 'ok') {
				return sendJson(res, 409, {
					ok: false, reason: 'watcher-uncovered', plugin: name, realpath: target, watch,
					hint: 'hmr 的观察根没盖住这份文件 ⇒ touch 了也不会有官方重载。前置＝junction 安装 + profile 补丁 `- id: hmr / disabled: false / config: { base: file:///<源码根>, root: [<包名>] }`（RULES §H.6.3 档 2）＋一次重启让它生效；或直接重启宿主换新字节。',
				})
			}
			const selfBefore = { generation: globalThis.__backroomApplyGeneration || 0, appliedAt: obs.appliedAt }
			let touchedAt = null
			let touchedMs = 0
			try {
				const stamp = new Date()
				fs.utimesSync(target, stamp, stamp)
				touchedAt = stamp.toISOString()
				touchedMs = stamp.getTime()
				obs.reload.touched += 1
			} catch (error) {
				obs.reload.errors += 1
				return sendJson(res, 500, { ok: false, reason: 'touch-failed', plugin: name, realpath: target, message: messageOf(error).slice(0, 200) })
			}
			const budget = query.waitMs === undefined ? RELOAD_WAIT_DEFAULT_MS : Math.max(0, Math.min(RELOAD_WAIT_MAX_MS, Number(query.waitMs) || 0))
			const startedAt = Date.now()
			let hit = null
			while (true) {
				// 证据读**globalThis 上的当前环**：重载本插件自己时命名空间整体换新、旧环停更，
				// 新环从"新 apply"那刻起接管捕获——官方行打在新环里（11-01 真机实测）。
				// 判据按 ts ≥ touch 时刻（留 1.5 s 钟差余量），不按位置——环可能整个换掉。
				const lines = (globalThis.__backroomRing || ring).all()
				for (let i = Math.max(0, lines.length - 60); i < lines.length; i += 1) {
					const line = lines[i]
					if (reloadEvidenceLine(line) && typeof line.ts === 'number' && line.ts >= touchedMs - 1500) { hit = line; break }
				}
				if (hit || Date.now() - startedAt >= budget) break
				await new Promise((r) => setTimeout(r, RELOAD_POLL_MS))
			}
			const waitedMs = Date.now() - startedAt
			if (hit) obs.reload.evidenceHits += 1
			else obs.reload.noEvidence += 1
			obs.reload.last = { plugin: name, at: touchedAt, evidence: Boolean(hit) }
			return sendJson(res, 200, {
				ok: true,
				plugin: name,
				realpath: target,
				watch,
				touchedAt,
				evidence: hit
					? { found: true, line: hit.text.slice(0, 300), name: hit.name, waitedMs }
					: { found: false, waitedMs, note: '等不到官方 `reload plugin at` 行不代表没生效（重载可能更慢，或字节没变时官方也会跳过）：自证＝GET /probe 的 self.generation/appliedAt（重载本插件时）或该插件自己的输出变化。' },
				selfBefore,
				note: '机制＝touch 已加载入口的 mtime（只动元数据），重载由官方 watcher 路径执行；本端点不调用 hmr 任何方法。',
			})
		} catch (error) {
			obs.reload.errors += 1
			sendJson(res, 500, { ok: false, reason: 'error', message: messageOf(error).slice(0, 300) })
		}
	}

	// ── 6) Agent 工具面（10-09 用户裁定：「补一下工具面，也要能新建工作区／我们插件的 wsl 工作区」）
	// 为什么要工具面：三枚只读端点任何本机进程都能 curl，但**会话里的模型不知道这个端口存在**——
	// 没有工具面就等于"只有被提示过的那一发能用"。注册成官方 defineTool 之后，它在任何 dsh 会话里可见。
	// 边界（安全优先）：
	//   · 只读三枚（probe/logs/faults）＝就地转调自家 handler，逻辑零副本（不留第二套真相源）；
	//   · 工作区创建＝**委托官面 `workspaceController.create({path})`**，且 path 必须落在
	//     DSH_BACKROOM_WORKSPACE_ROOTS 名单内（没设＝创建这档 disabled，只读档照常）；
	//   · WSL 工作区＝照 `dsh-wsl-workspace` 自己那条客户端顺序拼（官面 create ＋ 它 bridge 的
	//     registerWindows/setUser），**不复制它的私有状态**；bridge 打不通就整档如实报错，绝不半途。
	//   · `session` 那枚**不做成工具**（安全优先：不给任意会话一个"替你花钱"的按钮）。
	const toolsState = { status: 'not-attempted', registered: [], lastError: '' }
	obs.toolsState = toolsState

	const callLocal = async (handler, url, method = 'GET', body) => {
		let status = 0
		let text = ''
		const listeners = {}
		const req = { url, method, on: (ev, fn) => { (listeners[ev] ||= []).push(fn) }, destroy() {} }
		const res = {
			writeHead: (code, headers) => { status = code },
			end: (chunk) => { text = String(chunk || '') },
		}
		const pending = handler(req, res)
		if (pending && typeof pending.then === 'function') await pending
		if (body !== undefined) {
			for (const fn of listeners.data || []) fn(Buffer.from(body, 'utf8'))
			for (const fn of listeners.end || []) fn()
		}
		let parsed = null
		try { parsed = JSON.parse(text) } catch { parsed = { unparsable: text.slice(0, 200) } }
		return { status, json: parsed }
	}

	const registerAgentTools = async () => {
		const tools = ctx.get('tools', false)
		if (!tools || typeof tools.register !== 'function') { toolsState.status = 'absent（这档 profile 没挂 tools 服务）'; return }
		let defineTool = null
		let toolsImportSource = ''
		try {
			({ defineTool } = await import('@deepseek-ai/dsh-tools'))
			toolsImportSource = 'bare'
		} catch (bareError) {
			// 兜底：装侧若是**软链回源码树**（开发 link 形态），Node 按 realpath 解析 ⇒ 裸 import 会从源码树
			// 往上找，宿主的 node_modules 根本不在那条链上（10-30 真宿主实测 import-failed 就是这个）。
			// 宿主自己的安装根在 argv[2]（`<app.asar>/dsh`）、profile 在 argv[3]；在 Electron 的 fs 补丁下
			// 这两条都能 import（asar 路径也行，10-30 用 Electron-as-node 探针验过 import 与 require 都成立）。
			const candidates = []
			if (typeof process.argv[2] === 'string' && process.argv[2] !== '') candidates.push(path.join(process.argv[2], 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
			if (typeof process.argv[3] === 'string' && process.argv[3] !== '') {
				candidates.push(path.join(process.argv[3], 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
				candidates.push(path.join(process.argv[3], '..', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
			}
			const tried = [messageOf(bareError).slice(0, 120)]
			for (const candidate of candidates) {
				try {
					if (!fs.existsSync(candidate)) { tried.push('absent:' + candidate); continue }
					({ defineTool } = await import(pathToFileURL(candidate).href))
					toolsImportSource = 'host:' + candidate
					break
				} catch (error) { tried.push(messageOf(error).slice(0, 80)) }
			}
			if (typeof defineTool !== 'function') {
				toolsState.status = `import-failed: ${tried.join(' | ').slice(0, 300)}`
				return
			}
		}
		if (typeof defineTool !== 'function') { toolsState.status = 'import-failed: defineTool 不是函数'; return }
		toolsState.importSource = toolsImportSource
		const textOut = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
		const json = (value) => JSON.stringify(value)
		const qs = (base, pairs) => `${base}?${new URLSearchParams(pairs).toString()}`

		const readOnly = [
			{ name: 'backroom_probe', desc: '读宿主此刻的形状：官面服务面可达矩阵、本插件自己的计数（含会话入口的拒绝账）、node 版本。只读。', params: {}, run: async () => (await callLocal(probeHandler, '/dsh-backroom/probe')).json },
			{
				// 为什么要有这一枚：其他 agent 不会主动发现"dsh 里装了一枚调试插件"——工具名是它们每轮
				// 真正看得见的东西（§H.5：判"模型看见哪枚工具"只认 durable request/header 的 data.header.tools）。
				// 所以把"入口在哪、怎么调、有哪些闸、哪里不能做"做成一张只读卡，摆进工具面本身。
				name: 'backroom_entry',
				desc: 'dsh-backroom 的入口卡：后端端口怎么认、六枚端点的调用格式、每一把 env 闸、以及硬局限。要调 dsh 的日志/探针/会话窄口/建会话时**先读这一枚**。只读（不建会话、不发消息）。',
				params: {},
				run: async () => ({
					plugin: 'dsh-backroom',
					baseUrl: selfOrigin === '' ? null : `http://${selfOrigin}`,
					baseUrlNote: selfOrigin === ''
						? '还没观察到本插件被访问过 ⇒ 不知道端口。先按 discover 那一行找到端口，再对本插件发任意一枚只读请求（probe/roster 都行），此卡随后就会带 baseUrl。'
						: 'baseUrl 来自"本插件最近一次被以哪个环回 origin 访问过"（0.2.1-rc.2 起端口每次启动随机，别再猜 0.2.0 那个写死的常量）。',
					discover: '一条命令：node <本包>/tools/discover.mjs（输出 baseUrl/key/routes 的 JSON；校验探针正文，rc.5 的 API-key 网关面不再误认）。手认：在 DeepSeek Harness.exe 那一族 PID 的监听口里，找 GET /dsh-backroom/probe 回 200 **且正文含 "dsh-backroom"** 的那一枚；没有本插件时找根路径回 401 **且正文是** "dsh web authentication required" 的那一枚——rc.5 同进程另有一枚 API-key 网关面，所有路径都回 401 {"error":...invalid_api_key}，只看状态码会认错。',
					auth: {
						schemes: ['?key=<k>', 'header x-backroom-key: <k>', 'header Authorization: Bearer <k>'],
						envName: 'DSH_BACKROOM_SESSION_KEY',
						keyFile: process.env.DSH_BACKROOM_KEY_FILE || null,
						hint: keyHint(),
					},
					webDebug: {
						// 内置浏览器那条路（10-30 实测）：CLI web 实例没有 CDP，composer 是 Lexical。
						tool: 'tools/web-debug.mjs',
						start: 'node tools/web-debug.mjs start --home <仓外临时根> --workspace <目录> --port 3981 --key-env <PROVIDER_KEY_ENV> [--preset-file <cordis.patch.yml>]',
						snippet: 'node tools/web-debug.mjs snippet',
						stop: 'node tools/web-debug.mjs stop --home <同上>',
						note: '只发一发 beforeinput（再发 input 会翻倍）；execCommand 对 Lexical 无效；没选工作区时 contenteditable="false"；视口 0×0 / hidden 不挡页内 JS',
					},
					routes: [
						{ method: 'GET', path: '/dsh-backroom/probe', auth: 'none', what: '宿主形状＋服务面可达矩阵＋self（本插件 realpath/boot 代次）＋loadedPlugins（每枚已加载插件的 baseUrl/realpath，两份同名副本时指出运行中的是哪份）＋本插件计数' },
						{ method: 'GET', path: '/dsh-backroom/logs?limit=&level=&contains=', auth: 'none', what: '日志尾（logger 缓冲＋console 全五枚 error/warn/info/log/debug；level=log 过 console.log 那路）' },
						{ method: 'GET', path: '/dsh-backroom/faults?limit=&dir=', auth: 'none', what: '崩溃件归因（kill-shaped 会拒绝归因）' },
						{ method: 'GET', path: '/dsh-backroom/presets', auth: 'none', what: 'agentPreset 名册＋权限档目录＋五把闸状态' },
						{ method: 'GET', path: '/dsh-backroom/declarations', auth: 'none', what: '每枚 agentPreset 声明的体内文：rows（解析后的 composition 行）＋content（声明体 YAML）——变体验证（wsl-*）看这里，不必再给插件 lib 打 dump 探针' },
						{ method: 'GET', path: '/dsh-backroom/sessions?key=', auth: 'key', what: '本进程建设账（owned/spend/quota/budget）' },
						{ method: 'POST', path: '/dsh-backroom/sessions?key=', auth: 'key', what: '{cwd|workspaceId,agentPreset?,caller?} 建会话（cwd 与 workspaceId 二选一；后者＝加入已存在的工作区，路径仍要过 roots 白名单）；{op:"archive"|"unarchive",sessionId} 收回自己造的' },
						{ method: 'GET', path: '/dsh-backroom/session?key=&session=', auth: 'key', what: '读会话回合面（turnCount/lastResponseChars/spendTokens/permissionPreset）' },
						{ method: 'POST', path: '/dsh-backroom/session?key=&session=&wait=turn-end&timeoutMs=&mode=queue|steer', auth: 'key', what: '往会话发一条 prompt；wait=turn-end 会等到回合结束' },
						{ method: 'POST', path: '/dsh-backroom/reload?plugin=<包名>', auth: 'key', what: '按插件热重载：touch 已加载入口的 mtime（不碰内容）→ 官方 watcher 路径重载 → 捞官方 "reload plugin at" 日志行作证据。前置＝junction 安装＋hmr 观察根覆盖（RULES §H.6.3），盖不住时回 409 watcher-uncovered' },
					],
					env: [
						['DSH_BACKROOM_SESSION_KEY', '两枚动手端点的唯一钥匙；不设＝它们不存在（403 disabled）'],
						['DSH_BACKROOM_SESSION_ALLOW', '允许发消息的既有会话 id（逗号分隔）；不设＝只有本进程刚建的会话可达'],
						['DSH_BACKROOM_WORKSPACE_ROOTS', '建会话的 cwd 白名单（分号/逗号前缀）；不设＝建会话 disabled'],
						['DSH_BACKROOM_ALLOW_PRESETS', '可选：档位二次白名单；不设＝官面名册即白名单（broken 的仍拒）'],
						['DSH_BACKROOM_DENY_PRESETS', '可选：命中即拒发消息的权限档名单；不设＝只回显不拦'],
						['DSH_BACKROOM_MAX_SESSIONS_PER_HOUR', '建会话名额，默认 3'],
						['DSH_BACKROOM_TOKEN_BUDGET', '本插件建的会话累计 token 上限，默认 60000（≈4 回合）'],
					],
					limits: [
						'发消息：每分钟 6 发；text ≤4000 字符；body ≤16 KB；等待 2–120 s（默认 30 s）',
						'建会话：3 枚/小时（进程内窗口；失败会退回名额）；本进程账本，重启清零',
						'预算：只算本插件建的会话的 tokenUsage 投影；你手工开的会话不记在它账上',
					],
					notDone: [
						'不切模型（session/selectModel 会改后续每一发计费）',
						'session 与 sessions 刻意不做成工具 ⇒ 模型自己不能建会话/发消息，必须由外部进程带 key 调 HTTP',
						'归档＝官面"Hide one known Session from Workspace grouping surfaces"，是隐藏不是删除；盘上残留未量化',
						'不改权限档：全仓没有 permissionPresets.set（它做不到放宽）；要拦请点名 DSH_BACKROOM_DENY_PRESETS',
					],
				}),
			},
			{
				name: 'backroom_logs', desc: '读宿主日志尾（ctx.logger 全量＋插件 console 全五枚，自本插件 apply 起算）。只读。洪峰期会丢并计入 rateDropped，不许当审计账本。',
				params: { limit: { type: 'number', description: '取几行，默认 200，上限 4000。' }, level: { type: 'string', description: 'error|info|warn|debug|log 或官面数值档 0..3。' }, contains: { type: 'string', description: '子串过滤（对文本与来源名）。' } },
				run: async (a) => (await callLocal(logsHandler, qs('/dsh-backroom/logs', Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))))).json,
			},
			{
				name: 'backroom_faults', desc: '崩溃件归因：逐份报"哪一枚装侧包的哪一帧＋官面哪一帧抛的"；归不出的各回各原因，不硬捏。只读文件，不写盘。',
				params: { limit: { type: 'number', description: '列几份，默认 8，上限 20。' }, dir: { type: 'string', description: '可选：崩溃件目录，必须落在白名单根内。' } },
				run: async (a) => (await callLocal(faultsHandler, qs('/dsh-backroom/faults', Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))))).json,
			},
		]
		for (const spec of readOnly) {
			try {
				const dispose = tools.register(defineTool({
					name: spec.name,
					description: spec.desc,
					parameters: spec.params,
					output: textOut,
					async execute(args) { return json(await spec.run(args || {})) },
				}))
				toolsState.registered.push(spec.name)
				ctx.effect(() => dispose, `dsh-backroom tool ${spec.name}`)
			} catch (error) {
				toolsState.lastError = `${spec.name}: ${messageOf(error).slice(0, 200)}`
			}
		}
		// 工作区两枚（写档，默认关：没设 roots／distros 名单就只报 disabled，不做半截）
		// 判定式住在文件头的导出纯函数里（夹具能真验），这里只负责读 env 与执行。
		const rootVerdict = (target) => rootGate(process.env.DSH_BACKROOM_WORKSPACE_ROOTS, target)
		const distroVerdict = (distro) => distroGate(process.env.DSH_BACKROOM_WSL_DISTROS, distro)
		const resolveBridge = () => bridgeBase(process.env.DSH_BACKROOM_BRIDGE_BASE, selfOrigin)
		const bridge = (method, params) => new Promise((resolve) => {
			const target = resolveBridge()
			// 认不到基址就**一个字都不发**（旧版本会静默打到写死的 19387，新版那枚端口上根本没东西 ⇒ 假"桥坏了"）
			if (target.base === '') { resolve({ httpStatus: 0, ok: false, bridgeSource: target.source, error: target.reason }); return }
			const payload = JSON.stringify({ method, params: params || {} })
			const req = http.request(`${target.base}/wsl-workspace/api`, { method: 'POST', timeout: 15_000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
				let b = ''
				res.on('data', (c) => { if (b.length < 400_000) b += c })
				res.on('end', () => {
					let j = null
					try { j = JSON.parse(b) } catch { j = { unparsable: b.slice(0, 200) } }
					resolve({ httpStatus: res.statusCode, ok: j && j.ok === true, bridgeSource: target.source, bridgeBase: target.base, value: j ? j.value : undefined, error: j && j.ok === false ? j.error : undefined })
				})
			})
			req.on('error', (e) => resolve({ httpStatus: 0, ok: false, bridgeSource: target.source, bridgeBase: target.base, error: `bridge 不可达（${target.base}）：${messageOf(e).slice(0, 160)}` }))
			req.on('timeout', () => { req.destroy(); resolve({ httpStatus: 0, ok: false, bridgeSource: target.source, bridgeBase: target.base, error: `bridge 超时（${target.base}/wsl-workspace/api）` }) })
			req.write(payload)
			req.end()
		})
		// /mnt/<drive>/x → <Drive>:\x 与 UNC 拼装都在文件头的导出纯函数里（夹具直验），这里只调它们
		const officialCreate = async (pathToCreate) => {
			const wc = ctx.get('workspaceController', false)
			if (!wc || typeof wc.create !== 'function') return { ok: false, reason: 'no-workspaceController' }
			try {
				const r = await wc.create({ path: pathToCreate })
				const view = r && r.workspace ? r.workspace : r
				return { ok: true, created: Boolean(r && r.created === true), workspaceId: view && (view.id || view.workspaceId) || null, path: view && (view.path || view.root) || pathToCreate }
			} catch (error) {
				return { ok: false, reason: (error && error.code) || 'threw', message: messageOf(error).slice(0, 240) }
			}
		}
		const writeTools = [
			{
				name: 'backroom_workspace',
				desc: '工作区名册与新建。action=list 列本 profile 的工作区；action=create 建一枚（**已存在就回 created:false，官面本来就幂等**）。create 受 DSH_BACKROOM_WORKSPACE_ROOTS 白名单管：没设＝整档 disabled 并说明怎么设，绝不"顺手建在别处"。',
				params: {
					action: { type: 'string', required: true, enum: ['list', 'create'], description: 'list 或 create。' },
					path: { type: 'string', description: 'create 必填：绝对路径（Windows 路径或 \\\\wsl.localhost\\<distro>\\… 形 UNC）。' },
				},
				run: async (a) => {
					if (a.action === 'list') {
						const reg = ctx.get('workspaceRegistry', false)
						if (!reg) return { ok: false, reason: 'no-workspaceRegistry' }
						const rows = typeof reg.list === 'function' ? await reg.list() : (typeof reg.all === 'function' ? await reg.all() : null)
						if (rows === null) return { ok: false, reason: 'workspaceRegistry 既无 list 也无 all（别猜方法名，看这一格）' }
						return { ok: true, total: Array.isArray(rows) ? rows.length : null, workspaces: (Array.isArray(rows) ? rows : []).slice(0, 60).map((r) => ({ id: r.id || r.workspaceId || null, path: r.path || r.root || null, title: r.title || null })) }
					}
					const target = typeof a.path === 'string' ? a.path.trim() : ''
					if (target === '') return { ok: false, reason: 'path-required' }
					const verdict = rootVerdict(target)
					if (verdict !== 'ok') return { ok: false, reason: verdict, gate: 'DSH_BACKROOM_WORKSPACE_ROOTS', hint: '逗号/分号分隔的允许前缀；没设＝不建。设了但 path 不在其内＝outside-roots。' }
					return { ...(await officialCreate(target)), gated: true }
				},
			},
			{
				name: 'backroom_wsl_workspace',
				desc: 'WSL 工作区（委托 dsh-wsl-workspace 那枚插件的公开桥，不复制它的私有状态）。action=distros 列发行版；ls/check 探某枚 Linux 路径；create＝按它自己客户端那条顺序拼：官面 workspace/create（/mnt/<盘> 走盘符路径，其余走 \\\\wsl.localhost\\<distro>\\… UNC）＋它的 registerWindows/setUser。create 受 DSH_BACKROOM_WSL_DISTROS 白名单管。每一步单独报成没成，绝不半截成功。',
				params: {
					action: { type: 'string', required: true, enum: ['distros', 'ls', 'check', 'create'], description: '做什么。' },
					distro: { type: 'string', description: 'WSL 发行版名（ls/check/create 必填）。' },
					path: { type: 'string', description: 'Linux 绝对路径，如 /home/ruler/proj 或 /mnt/e/tmp。' },
					username: { type: 'string', description: '可选：以哪个 Linux 用户进（create 的 setUser 分支用）。' },
				},
				run: async (a) => {
					if (a.action === 'distros') return await bridge('listDistros', {})
					if (a.action === 'ls') return await bridge('listDir', { distro: a.distro, path: a.path })
					if (a.action === 'check') return await bridge('check', { distro: a.distro, path: a.path })
					const distro = typeof a.distro === 'string' ? a.distro.trim() : ''
					const linuxPath = typeof a.path === 'string' ? a.path.trim() : ''
					if (distro === '' || !linuxPath.startsWith('/')) return { ok: false, reason: 'distro-and-absolute-linux-path-required' }
					const verdict = distroVerdict(distro)
					if (verdict !== 'ok') return { ok: false, reason: verdict, gate: 'DSH_BACKROOM_WSL_DISTROS', hint: '没设＝这档不建；设了但不含这枚发行版＝not-allowed-distro。' }
					const { target, branch } = wslTargets(distro, linuxPath)
					const made = await officialCreate(target)
					if (!made.ok) return { ok: false, stage: 'workspace/create', target, distro, linuxPath, ...made, hint: '官面 create 失败时**没有**去动那枚插件的私有状态（不留半截）' }
					const reg = branch === 'unc'
						? await bridge('setUser', { path: target, ...(typeof a.username === 'string' && a.username !== '' ? { username: a.username } : {}) })
						: await bridge('registerWindows', { distro, linuxPath, ...(typeof a.username === 'string' && a.username !== '' ? { username: a.username } : {}) })
					return {
						ok: made.ok && reg.ok !== false, stage: reg.ok === false ? 'wsl-register' : 'done',
						branch, target, workspaceId: made.workspaceId, created: made.created,
						register: reg,
						hint: reg.ok === false ? '工作区建好了，但那枚插件的 WSL 登记没成 ⇒ 会话的 bash 可能不会进 WSL。按 register.error 原样修（多半是 distro/路径/用户名形状），别手改 ~/.dsh/wsl-workspaces.json。' : undefined,
					}
				},
			},
		]
		for (const spec of writeTools) {
			try {
				const dispose = tools.register(defineTool({
					name: spec.name,
					description: spec.desc,
					parameters: spec.params,
					output: textOut,
					async execute(args) { return json(await spec.run(args || {})) },
				}))
				toolsState.registered.push(spec.name)
				ctx.effect(() => dispose, `dsh-backroom tool ${spec.name}`)
			} catch (error) {
				toolsState.lastError = `${spec.name}: ${messageOf(error).slice(0, 200)}`
			}
		}
		toolsState.status = `registered(${toolsState.registered.length})`
	}
	void registerAgentTools()

	// 0.2.1-rc.2 起端口随机 ⇒ 桥基址只能"env 显式给"或"自家 Host 头观察到"，都不给就如实 unknown（bridgeBase 里写明）。
	let selfOrigin = ''
	const routes = [
		{ kind: 'exact', path: '/dsh-backroom/probe', handler: probeHandler },
		{ kind: 'exact', path: '/dsh-backroom/logs', handler: logsHandler },
		{ kind: 'exact', path: '/dsh-backroom/faults', handler: faultsHandler },
		{ kind: 'exact', path: '/dsh-backroom/presets', handler: presetsHandler },
		{ kind: 'exact', path: '/dsh-backroom/declarations', handler: declarationsHandler },
		{ kind: 'exact', path: '/dsh-backroom/sessions', handler: sessionsHandler },
		{ kind: 'exact', path: '/dsh-backroom/session', handler: sessionHandler },
		{ kind: 'exact', path: '/dsh-backroom/reload', handler: reloadHandler },
	].map((route) => ({
		...route,
		// 顺手记下发给自己的请求用的那枚环回 origin ⇒ WSL 桥基址的唯一自认路（见 loopbackOrigin 的注释）
		handler: (req, res) => {
			const origin = loopbackOrigin(req && req.headers ? req.headers.host : '')
			if (origin !== '') selfOrigin = origin
			return route.handler(req, res)
		},
	}))
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

	// 就绪行走**双路**（11-01 起）：logger 进自家日志尾；console.log 进自家捕获环——
	// 每次启动/热重载都顺手自证"console.log 捕获"这一格活没活（11-01 痛点 4 的验收线，
	// 当天 dsh-wsl-workspace 的 `WSL preset variants: 4/4 registered` 就是死在这一格上），
	// 也会落进崩溃件的子进程 stderr 尾巴（10-04 的读数：那是装机端唯一会留 stdout 痕迹的地方）。
	const readyNote = '[backroom] host half ready (8 routes: probe, logs, faults, presets, declarations — 前五枚只读免 key；sessions 建/收、session 发、reload 热重载 — 后三枚要 env key，sessions 还额外要建会话白名单)'
	if (typeof loggerFace?.info === 'function') loggerFace.info(readyNote)
	console.log(readyNote)
}
