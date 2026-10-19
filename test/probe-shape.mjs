// test/probe-shape.mjs — dsh-backroom 宿主半的离线冒烟套件
//
// 为什么要有：这枚插件的全部价值是"到真宿主里读一眼"，但它同时带着会把宿主拖死的三类副作用
// ——全局包 console、对任意日志参数做 inspect、以及装配期注册抛错带走整包
// （10-04 真宿主上就因为它包了全五枚 console + 无界 inspect，后端起后 60–90 秒反复退出，
//   A/B 凭据见 PITFALLS #103：摘掉插件 ⇒ 后端活满 120 秒、GET / 回 401）。
// 所以本套件的承重墙是**那三把界**：环形淘汰算术、重入闸、速率闸、逐参数封顶。
// 它**不**声称验过真宿主：真读数走 GET /dsh-backroom/probe（"端点回包"档，与本档的"夹具档"不互冒充）。
//
// 跑法：node test/probe-shape.mjs （零依赖、零网络、不起进程、不写盘、不睡长觉）

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcFile = path.join(here, '..', 'lib', 'index.js')
const source = fs.readFileSync(srcFile, 'utf8')

let passed = 0
const step = (label) => {
	passed += 1
	console.log(`  ${String(passed).padStart(2, '0')} ok — ${label}`)
}

// ── 假 ctx ────────────────────────────────────────────────────────────────
function makeLoggerFace() {
	const exporters = []
	const face = {
		buffer: [
			{ sn: 1, ts: 1, name: 'boot', type: 'warn', level: 2, args: ['dsh: warning: 1 entries did not activate'] },
			{ sn: 2, ts: 2, name: 'boot', type: 'info', level: 1, args: ['composed 6 layers'] },
		],
		exporter(exporter) {
			exporters.push(exporter)
			return { dispose: async () => {} }
		},
		info(...args) { face.recorded.push(['info', args]) },
		recorded: [],
	}
	return { face, exporters }
}

function makeCtx({ logger, hmrPresent = true, blockPlanMode = true, sessionController, tools = true } = {}) {
	const table = new Map()
	// 真宿主同形：`ctx.get('logger')` 取不到（10-04 现读 absent），只有 `ctx.logger` 属性拿得到
	// ⇒ logger 一律**不进名字表**，改成属性 getter，让"属性回退"那半条路真被测到。
	if (hmrPresent) {
		table.set('hmr', { watchConfig() {}, getLinked() { return { linked: ['dsh-backroom'] } } })
	}
	table.set('profileContext', { dir: 'X', patchPath: 'Y' })
	if (tools !== false) table.set('tools', { __captured: [], register(tool) { this.__captured.push(tool); return () => {} } })
	if (sessionController !== false) table.set('sessionController', sessionController || { prompt() {}, follow() {}, list() {} })
	table.set('pluginInventory', { list: () => [{ id: 'backroom', enabled: true, fiberPhase: 'active' }] })

	const effects = []
	const routes = []
	const ctx = {
		fiber: { state: 2 },
		get(name, strict = true) {
			if (strict && blockPlanMode && name === 'planMode') throw new Error('service "planMode" is not available')
			return table.get(name)
		},
		effect(fn) { effects.push(fn()) },
		webServer: {
			register(route) {
				routes.push(route)
				return () => {
					const index = routes.indexOf(route)
					if (index >= 0) routes.splice(index, 1)
				}
			},
		},
	}
	Object.defineProperty(ctx, 'commands', {
		get() { throw new Error('property access denied: "commands" is not declared in inject') },
	})
	if (logger) Object.defineProperty(ctx, 'logger', { get() { return logger }, configurable: true })
	return { ctx, effects, routes, table }
}

const makeRes = () => {
	const res = { status: 0, headers: null, body: '' }
	res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
	res.end = (value) => { res.body = value }
	return res
}

const call = (route, url) => {
	const res = makeRes()
	route.handler({ url, method: 'GET' }, res)
	return { status: res.status, headers: res.headers, json: JSON.parse(res.body || 'null') }
}

// 会话窄口那枚 handler 是 async 的，还要吃 POST body ⇒ 单独一发：先挂 handler，
// 再在 setImmediate 里把 body 当 data/end 事件喂进去（readBody 那时已经注册好监听）。
const callAs = async (route, method, url, body) => {
	const res = makeRes()
	const listeners = {}
	const req = { url, method, on(ev, fn) { (listeners[ev] ||= []).push(fn) }, destroy() {} }
	const pending = route.handler(req, res)
	setImmediate(() => {
		if (body !== undefined && body !== null) for (const fn of listeners.data || []) fn(Buffer.from(body, 'utf8'))
		for (const fn of listeners.end || []) fn()
	})
	if (pending && typeof pending.then === 'function') await pending
	return { status: res.status, json: JSON.parse(res.body || 'null') }
}

const routeOf = (routes, name) => routes.find((r) => r.path === `/dsh-backroom/${name}`)

// ── 1. 导出形状 ────────────────────────────────────────────────────────────
const mod = await import(`file:///${srcFile.replace(/\\/g, '/')}`)
assert.equal(mod.name, 'backroom')
assert.deepEqual(mod.inject, ['webServer'])
assert.equal(typeof mod.apply, 'function')
assert.equal(typeof mod.createRing, 'function')
step('宿主半导出 name/inject/apply/createRing（inject 只有 webServer，绝不硬依赖 logger）')

// ── 2. 环形淘汰算术：小规模直接证，不靠把默认上限调大 ──────────────────────
{
	const ring = mod.createRing(5)
	for (let i = 1; i <= 8; i += 1) ring.push({ text: `l${i}` })
	assert.equal(ring.size(), 5, `size=${ring.size()}`)
	assert.equal(ring.dropped(), 3, `dropped=${ring.dropped()}`)
	assert.deepEqual(ring.slice(2).map((x) => x.text), ['l7', 'l8'], '留下的是最新的')
	assert.deepEqual(ring.all().map((x) => x.text), ['l4', 'l5', 'l6', 'l7', 'l8'])
}
step('createRing：limit=5 投 8 枚 ⇒ size=5／dropped=3／末两枚确实是 l7,l8')

// ── 3. 装载：路由 + exporter + console 只包 error/warn ─────────────────────
const originalLog = console.log
const originalError = console.error
const originalWarn = console.warn
const originalInfo = console.info
const { face: loggerFace, exporters } = makeLoggerFace()
const { ctx, effects, routes } = makeCtx({ logger: loggerFace })
mod.apply(ctx)

assert.equal(routes.length, 4, `注册到的路由数=${routes.length}`)
assert.deepEqual(routes.map((r) => r.path).sort(), ['/dsh-backroom/faults', '/dsh-backroom/logs', '/dsh-backroom/probe', '/dsh-backroom/session'])
assert.ok(routes.every((r) => r.path.startsWith('/dsh-backroom/')))
assert.ok(!routes.some((r) => r.path.startsWith('/api')), '绝不占用 /api 前缀（RULES §C4）')
assert.equal(exporters.length, 1, 'ctx.logger.exporter 注册成功')
const obs = globalThis.__backroomObservations
assert.equal(obs.exporterState, 'registered')
assert.equal(obs.routeRegistrations, 4)
assert.equal(obs.mountErrors, 0, `mountErrors=${obs.mountErrors} lastError=${obs.lastError}`)
assert.equal(obs.bufferLenAtRegister, 2, '记下注册时的缓冲长度，用来判"能不能回放"')
assert.equal(obs.loggerFace, 'present-via-property', '真宿主同形：logger 走属性能拿到')
assert.equal(obs.consolePatchState, 'patched(2:error/warn)', `实际=${obs.consolePatchState}`)
assert.notEqual(console.error, originalError, 'console.error 被包')
assert.notEqual(console.warn, originalWarn, 'console.warn 被包')
assert.equal(console.log, originalLog, '10-04 事故后收窄：热路径 console.log/info **不再**被接管')
assert.equal(console.info, originalInfo, 'console.info 保持原样')
step('装载形状：4 枚路由（3 枚只读＋1 枚默认关的会话窄口，无 /api）＋exporter＋console 只包 error/warn 两枚')

// ── 4. 两路日志同框，且 src 计到 obs 上 ────────────────────────────────────
exporters[0].export({ sn: 10, ts: 1234, name: 'dsh-hmr', type: 'info', level: 1, args: ['reloading', { id: 'backroom' }] })
exporters[0].export({ sn: 11, ts: 1235, name: 'shredder', type: 'error', level: 0, args: [new Error('detach failed')] })
console.error('[backroom-marker] console path reached')

const logsRoute = routeOf(routes, 'logs')
const logs = call(logsRoute, '/dsh-backroom/logs?limit=50')
assert.equal(logs.status, 200)
assert.equal(logs.headers['cache-control'], 'no-store')
const texts = logs.json.lines.map((l) => l.text)
assert.ok(texts.some((t) => t.includes('reloading') && t.includes('backroom')), 'logger 那一路进得来且参数被渲染')
assert.ok(texts.some((t) => t.startsWith('Error: detach failed')), 'Error 参数按 name: message 渲染')
assert.ok(texts.some((t) => t.includes('[backroom-marker] console path reached')), 'console.error 那一路进得来')
assert.ok(logs.json.lines.some((l) => l.src === 'console') && logs.json.lines.some((l) => l.src === 'logger'))
assert.equal(obs.consoleLines, 1, `consoleLines=${obs.consoleLines}`)
assert.equal(logs.json.rate.reentrantSkips, 0)
step('两路日志同框：ctx.logger.exporter 与 console.error（计数各归各，consoleLines=1）')

// ── 5. level 过滤（数值档与名字两写）与坏值 ────────────────────────────────
const onlyError = call(logsRoute, '/dsh-backroom/logs?level=error')
assert.ok(onlyError.json.lines.length >= 1 && onlyError.json.lines.every((l) => l.type === 'error'))
const alsoError = call(logsRoute, '/dsh-backroom/logs?level=0')
assert.deepEqual(alsoError.json.lines.map((l) => l.sn), onlyError.json.lines.map((l) => l.sn))
const badLevel = call(logsRoute, '/dsh-backroom/logs?level=bogus')
assert.equal(badLevel.status, 400)
assert.deepEqual(badLevel.json.allowed.sort(), ['debug', 'error', 'info', 'warn'])
const filtered = call(logsRoute, '/dsh-backroom/logs?contains=backroom-marker')
assert.equal(filtered.json.lines.length, 1, `contains 命中数=${filtered.json.lines.length}`)
step('level 收 0..3 与名字两写、坏值回 400 并点名合法档；contains 生效')

// ── 6. 速率闸：一秒内灌 4100 条只收 RATE_LIMIT 条，其余计数说得出 ──────────
exporters[0].export({ sn: 19, ts: 1239, name: 'rate-anchor', type: 'info', level: 1, args: ['anchor-before-flood'] })
const beforeFlood = obs.logLines
for (let i = 0; i < 4100; i += 1) exporters[0].export({ sn: 1000 + i, ts: 2000 + i, name: 'flood', type: 'info', level: 1, args: [`flood ${i}`] })
const flooded = call(logsRoute, '/dsh-backroom/logs?limit=1')
assert.ok(obs.rateDropped >= 3700, `rateDropped=${obs.rateDropped}（4100 条灌进去，绝大多数必须被闸挡下）`)
assert.ok(obs.logLines - beforeFlood <= 420, `本秒新增捕获=${obs.logLines - beforeFlood}（RATE_LIMIT=200，允许跨一个窗口）`)
assert.equal(flooded.json.rate.windowMs, 1000)
assert.ok(flooded.json.lines[0].text.startsWith('flood'), '末条确实是洪流里的那一枚')
step('速率闸生效：灌 4100 条 ⇒ rateDropped≥3700、新增捕获≤420、端点把闸的读数带出来')

// ── 7. 重入闸：参数对象在被 inspect 时自己打 console ⇒ 必须跳过而不是递归 ───
// 上一节的洪流把这一秒的 200 条额度用光了（速率闸是真的在挡），等窗口翻一次再测。
await new Promise((resolve) => setTimeout(resolve, 1100))
let customInspectCalls = 0
const explosive = {
	[Symbol.for('nodejs.util.inspect.custom')]() {
		customInspectCalls += 1
		console.error('[backroom-reentrant] 我在被 inspect 的过程中又打了一条日志')
		return 'Expensive{}'
	},
}
const reentrantBaseline = obs.consoleLines
exporters[0].export({ sn: 9000, ts: 9000, name: 'reentry', type: 'info', level: 1, args: [explosive] })
assert.equal(customInspectCalls, 1, 'custom inspect 确实被走过一发')
assert.ok(obs.reentrantSkips >= 1, `reentrantSkips=${obs.reentrantSkips}（内层那一发必须被闸挡掉）`)
assert.equal(obs.consoleLines, reentrantBaseline, '内层 console.error 没有变成第二次捕获')
assert.equal(obs.captureErrors, 0)
const reentry = call(logsRoute, '/dsh-backroom/logs?contains=Expensive')
assert.equal(reentry.json.lines.length, 1, '外层那一条仍然留下了，且渲染出了 custom inspect 的文本')
step('重入闸生效：inspect 里再打日志 ⇒ 外层照记、内层被挡（reentrantSkips≥1），没有递归')

// ── 8. 逐参数封顶：500 KB 的串进来也只能占 TEXT_LIMIT 个字符 ───────────────
const huge = 'x'.repeat(500 * 1024)
exporters[0].export({ sn: 9100, ts: 9100, name: 'bigarg', type: 'info', level: 1, args: [huge, { note: 'tail' }] })
const bigLine = call(logsRoute, '/dsh-backroom/logs?limit=1').json.lines[0]
assert.ok(bigLine.text.length <= 600, `text 长度=${bigLine.text.length}`)
assert.equal(bigLine.name, 'bigarg')
const wide = { list: new Array(3000).fill(0).map((v, i) => ({ i, pad: 'y'.repeat(300) })) }
exporters[0].export({ sn: 9101, ts: 9101, name: 'wideobj', type: 'info', level: 1, args: [wide] })
const wideLine = call(logsRoute, '/dsh-backroom/logs?contains=wideobj&limit=2').json.lines
assert.ok(wideLine[wideLine.length - 1].text.length <= 600, '大对象同样封顶')
step('逐参数封顶：500 KB 字符串与 3000 元素数组都只占 ≤600 字符（不是拼完整串再切）')

// ── 9. 探针端点：可达矩阵 + 属性访问 + hmr + 缓冲回放 ──────────────────────
const probeRoute = routeOf(routes, 'probe')
const body = call(probeRoute, '/dsh-backroom/probe').json
assert.ok(Array.isArray(body.services) && body.services.length >= 20, `services=${body.services && body.services.length}`)
const rowOf = (name) => body.services.find((row) => row.name === name)
assert.equal(rowOf('logger').strict, 'absent', '真宿主同形：ctx.get(logger) 取不到')
assert.equal(rowOf('sessionController').strict, 'present(object)')
assert.ok(rowOf('sessionController').keys.includes('prompt'), '夹具档：列出的是假面自己的方法名（真宿主那帧列的是 typertRemote/agents/commands…）')
assert.ok(rowOf('planMode').strict.startsWith('threw:'), 'strict 抛错要如实记成 threw，不许折成 absent')
assert.equal(rowOf('planMode').loose, 'absent')
assert.equal(body.propertyAccess.webServer, 'present(object)')
assert.ok(body.propertyAccess.commands.startsWith('threw:'), '未声明依赖的属性访问抛错要被吞下并记账')
assert.equal(body.hmr.face, 'present(object)')
assert.match(String(body.hmr.getLinked), /not-called/, '10-04 起：探针**不许调用**外来面的方法（getLinked 那一发把后端拖死过）')
assert.equal(body.buffer.len, 2, '注册前已在场的缓冲条数要说得出（回放能力的那一发读数）')
assert.ok(body.buffer.head[0].includes('did not activate'), '缓冲头部文本可读＝启动告警能不能回放判得出来')
assert.equal(body.fiberState, 2)
assert.equal(body.plugin.shape, 'probe-only')
assert.ok(body.host.node.startsWith('v') && Array.isArray(body.host.dshEnvNames))
assert.ok(!JSON.stringify(body).includes('token='), '探针输出里绝不含 token')
const totalTested = body.services.length
const present = body.services.filter((s) => String(s.strict).startsWith('present')).length
// 夹具档只保证"矩阵打得出来"；真宿主那一帧的数字（24/27 strict 在场）记在
// docs/compat/VERSIONS/0.2.0-rc.2/MANIFEST.json 的 P20-10，两档不许互冒充。
assert.ok(present >= 4, `夹具档里 strict 在场=${present}/${totalTested}`)
step(`探针矩阵：strict/loose 分开报、抛错如实记 threw、缓冲回放有读数、无 token（${present}/${totalTested} 在场）`)

// ── 10. hmr／logger 都不在场时的降级（不许抛、不许猜）─────────────────────
const degraded = makeCtx({ logger: undefined, hmrPresent: false })
mod.apply(degraded.ctx)
const degradedRes = call(routeOf(degraded.routes, 'probe'), '/dsh-backroom/probe')
assert.equal(degradedRes.status, 200)
const degradedBody = degradedRes.json
assert.equal(degradedBody.hmr.face, 'absent')
assert.ok(degradedBody.plugin.loggerFace.startsWith('absent'))
assert.equal(degradedBody.plugin.exporterState, 'not-attempted')
assert.equal(degradedBody.plugin.routeRegistrations, 4, '取不到 logger 也要照样把四枚端点挂上（会话窄口自己按 env 关门）')
assert.ok(degradedBody.plugin.consolePatchState.includes('already-wrapped'), '重复 apply 走"已包过就不再包"那一路')
step('降级档：没有 logger／没有 hmr 时端点照挂、状态写成 absent；重复 apply 不叠第二层补丁')

// ── 11. 怪值日志不能把端点打死（jsonSafe + 封顶渲染，走真捕获那条路）──────
// 10-04 之后这些值**不再**来自"调用官面方法"（那一发把后端拖死过），只可能来自日志参数。
const odd = { fn() {}, big: 10n, nan: Number.NaN, sym: Symbol('s'), arr: [1, 2], deep: { a: { b: { c: { d: { e: 1 } } } } } }
odd.cyclic = odd
exporters[0].export({ sn: 9500, ts: 9500, name: 'odd-payload', type: 'info', level: 1, args: [odd] })
const oddRes = call(logsRoute, '/dsh-backroom/logs?contains=odd-payload')
assert.equal(oddRes.status, 200, '含函数/循环/BigInt/NaN/Symbol/超深的日志参数，端点仍回 200')
assert.equal(oddRes.json.lines.length, 1)
assert.ok(oddRes.json.lines[0].text.length <= 600, `渲染结果被封顶=${oddRes.json.lines[0].text.length}`)
assert.ok(oddRes.json.lines[0].text.includes('cyclic') || oddRes.json.lines[0].text.includes('Map'), '循环对象由 inspect 自己兜住，不是我们崩')
const stillProbe = call(probeRoute, '/dsh-backroom/probe')
assert.equal(stillProbe.status, 200)
assert.equal(typeof stillProbe.json.hmr.getLinked, 'string', 'hmr 那一格从此只是一个说明串，我们不动它')
step('怪值日志参数不打死端点（≤600 封顶），且探针不再调用任何官面方法')

// ── 11b. /dsh-backroom/faults：崩溃件归因端点（读 test/fixtures 那一份，不碰真用户数据）──
const faultsRoute = routeOf(routes, 'faults')
const fixturesDir = path.join(here, 'fixtures')
process.env.DSH_BACKROOM_CRASH_LOGS = fixturesDir
process.env.DSH_BACKROOM_SOURCE_ROOT = path.join(here, '..', '..')
try {
	const f = call(faultsRoute, '/dsh-backroom/faults?limit=8')
	assert.equal(f.status, 200, `faults 状态=${f.status} ${JSON.stringify(f.json)}`)
	assert.equal(f.json.ok, true)
	assert.equal(path.posix.basename(f.json.dir), 'fixtures', '默认根要落在 env 指的那一棵，不是 %APPDATA%')
	assert.ok(f.json.faults.length >= 4, `夹具应有 4 份，实际=${f.json.faults.length}`)
	assert.ok(f.json.faults.every((x) => !x.file.includes('/') && !x.file.includes('\\')), '回包只给文件名，不给整条本机路径')
	const hit = f.json.faults.find((x) => x.culprit)
	assert.equal(hit.culprit.bundle, 'dsh-backroom', `归因结果=${JSON.stringify(hit.culprit)}`)
	assert.ok(hit.official.file.includes('dsh-hmr'), '官面抛出点要带进来')
	assert.ok(f.json.faults.every((x) => x.culprit || x.noCulpritReason), '不可归因的那几份必须各带原因，不许静默消失')
	assert.match(f.json.next, /quarantine/, '回包要指得回"摘掉走命令行"那条路')
	assert.ok(!JSON.stringify(f.json).includes('token'), '崩溃件里若有 token 形状不得外泄')

	const denied = call(faultsRoute, '/dsh-backroom/faults?dir=' + encodeURIComponent(path.join(here, '..', '..', 'docs')))
	assert.equal(denied.status, 403, '白名单外的 dir 必须拒（免鉴权端点不能当本机文件读 oracle）')
	assert.equal(denied.json.reason, 'dir-outside-allowed-roots')
	const traversal = call(faultsRoute, '/dsh-backroom/faults?dir=' + encodeURIComponent(fixturesDir + '/../../docs'))
	assert.equal(traversal.status, 403, '`..` 逃逸在 resolve 之后仍要拒')

	const capped = call(faultsRoute, '/dsh-backroom/faults?limit=99999')
	assert.ok(capped.json.returned <= 20, `limit 封顶失效=${capped.json.returned}`)
	step('faults 端点：夹具 4 份归因得出、不可归因的带原因、dir 白名单与 `..` 逃逸都拒、limit 有界')
} finally {
	delete process.env.DSH_BACKROOM_CRASH_LOGS
	delete process.env.DSH_BACKROOM_SOURCE_ROOT
}

// ── 12. 卸下补丁：console.error/warn 必须还原到真原函数 ────────────────────
assert.equal(obs.reentrantSkips >= 1, true)
for (const disposer of effects) {
	if (typeof disposer === 'function') await disposer()
	else if (disposer && typeof disposer.dispose === 'function') await disposer.dispose()
}
assert.equal(console.error, originalError, 'effect 卸完 console.error 回到真原函数')
assert.equal(console.warn, originalWarn, 'console.warn 同样还原')
assert.equal(obs.consolePatchState, 'restored')
const tailBefore = call(logsRoute, '/dsh-backroom/logs?limit=1').json.tailTotal
console.error('[backroom-marker] after restore')
const tailAfter = call(logsRoute, '/dsh-backroom/logs?limit=1').json.tailTotal
assert.equal(tailAfter, tailBefore, '还原之后不再吃日志')
step('写分支收尾：disposer 跑完后 error/warn 都回到真原函数、还原后不吃日志')

// ── 14. 会话窄口（10-05 用户裁定「开全套窄口」）：五把闸逐把验，默认关＝一枚都不放行 ──
{
	const calls = []
	const outlineOf = (n, responded = true) => ({
		asOfSeq: 100 + n,
		values: {
			turnOutline: Array.from({ length: n }, (_, i) => ({ turn: i + 1, seq: 10 + i, prompt: 'p', response: responded || i < n - 1 ? 'r' : '' })),
			sessionStats: { turns: n, lastTurn: null },
			modelSelection: { lastUsed: { provider: 'sensenova', model: 'deepseek-v4-flash', reasoningEffort: 'low' }, next: null },
		},
	})
	const gateFake = {
		async prompt(request) { calls.push(request); return { accepted: true } },
		async projections() { return outlineOf(7) },
	}
	const fresh = makeCtx({ sessionController: gateFake })
	mod.apply(fresh.ctx)
	const sessObs = globalThis.__backroomObservations.session
	const route = routeOf(fresh.routes, 'session')
	const KEY = 'sekret-key'
	const SID = 'sess-allow-1'
	const post = (qs, body) => callAs(route, 'POST', `/dsh-backroom/session${qs}`, body)
	try {
		// 闸 1：env 没设 key ⇒ 这枚端点等于不存在（连"带对 key"也不放行）
		delete process.env.DSH_BACKROOM_SESSION_KEY
		delete process.env.DSH_BACKROOM_SESSION_ALLOW
		assert.equal((await post(`?key=${KEY}&session=${SID}`, '{}')).json.reason, 'disabled')
		assert.equal(calls.length, 0, '没放行之前官面 prompt 一枚都不该被调到')

		// 闸 2：key 缺失/不符
		process.env.DSH_BACKROOM_SESSION_KEY = KEY
		assert.equal((await post(`?session=${SID}`, '{}')).json.reason, 'no-key')
		assert.equal((await post(`?key=wrong-key&session=${SID}`, '{}')).json.reason, 'bad-key')

		// 闸 3：只认登记过的会话，**绝不新建、绝不挑最近一枚**
		delete process.env.DSH_BACKROOM_SESSION_ALLOW
		assert.equal((await post(`?key=${KEY}&session=${SID}`, '{}')).json.reason, 'no-allowlist')
		process.env.DSH_BACKROOM_SESSION_ALLOW = 'sess-allow-1, sess-allow-2'
		assert.equal((await post(`?key=${KEY}&session=sess-not-listed`, '{}')).json.reason, 'not-allowlisted')
		assert.equal((await callAs(route, 'GET', `?key=${KEY}`)).json.reason, 'no-session')
		assert.equal(calls.length, 0, '四道闸之外仍是一枚都没放行')

		// 闸 5：形状与长度上界（全部有界，坏输入不许打到官面）
		assert.equal((await post(`?key=${KEY}&session=${SID}`, JSON.stringify({ text: '   ' }))).json.reason, 'empty-text')
		assert.equal((await post(`?key=${KEY}&session=${SID}`, JSON.stringify({ text: 'a'.repeat(4001) }))).json.reason, 'text-too-long')
		assert.equal((await post(`?key=${KEY}&session=${SID}`, '{oops')).json.reason, 'bad-json')
		assert.equal((await post(`?key=${KEY}&session=${SID}`, JSON.stringify({ text: 'b'.repeat(20000) }))).json.reason, 'body-too-large')
		assert.equal(calls.length, 0, '形状不合格的一发都不许打到官面')

		// 放行那一发：官面收到的 request 形状＝现读的 handler（sessionId/requestId/content 分片）
		const okRes = await post(`?key=${KEY}&session=${SID}`, JSON.stringify({ text: '只回一个字：好' }))
		assert.equal(okRes.status, 200, `实际=${okRes.status} ${JSON.stringify(okRes.json)}`)
		assert.equal(okRes.json.accepted, true)
		assert.equal(okRes.json.wait, 'not-requested', '没带 wait=turn-end ⇒ 只报接没接，不报回合结束')
		assert.equal(calls.length, 1)
		assert.equal(calls[0].sessionId, SID)
		assert.deepEqual(calls[0].content, [{ type: 'text', text: '只回一个字：好' }])
		assert.match(calls[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'requestId 要带上（官面靠它做幂等去重）')

		// 只读档 GET：读的是官面投影袋里**确实在册**的那两枚（turnOutline 数组／sessionStats.turns）
		const state = await callAs(route, 'GET', `?key=${KEY}&session=${SID}`)
		assert.equal(state.json.face, 'ok')
		assert.equal(state.json.turnCount, 7, `实际=${JSON.stringify(state.json)}`)
		assert.equal(state.json.lastTurn, 7)
		assert.equal(state.json.lastResponseChars, 1, '最后一回合的 response 长度（turn/end 填的）')
		assert.equal(state.json.readable, true)
		assert.ok(state.json.projectionKeys.includes('turnOutline'))
		// 10-09 用户补的那一格：**只读**当前用哪个 provider/model（切模型不在范围内，它会改后续每一发的计费）
		assert.deepEqual(state.json.model.lastUsed, { provider: 'sensenova', model: 'deepseek-v4-flash', reasoningEffort: 'low' }, JSON.stringify(state.json.model))
		assert.equal(state.json.model.next, null)
		assert.ok(!/\bselectModel\s*\(/.test((await import('node:fs')).readFileSync(srcFile, 'utf8').replace(/^\s*\/\/.*$/gm, '')), '只许读 modelSelection，绝不切模型')

		// 闸 4：速率——灌到出 429 为止，窗口内的发数不许越过上限
		let flooded = null
		for (let i = 0; i < 20 && !flooded; i += 1) {
			const r = await post(`?key=${KEY}&session=${SID}`, JSON.stringify({ text: 'ping' }))
			if (r.status === 429) flooded = r
		}
		assert.ok(flooded, '20 发内必须撞到速率闸')
		assert.equal(flooded.json.reason, 'rate-limited')
		assert.equal(flooded.json.limit, 6, '默认 6 发/分钟（改大要留来源注）')
		assert.equal(sessObs.stamps.length, 6, `窗口内计数=${sessObs.stamps.length}`)
		assert.equal(sessObs.rateDropped, 1)

		// 等待档 A：多出一回合且那一回合带 response ⇒ ended true，读数（waitedMs/deadline/前后帧）全带
		let reads = 0
		const advancing = makeCtx({ sessionController: {
			async prompt() { return { accepted: true } },
			async projections() { reads += 1; return outlineOf(7 + Math.min(2, Math.ceil(reads / 2))) },
		} })
		mod.apply(advancing.ctx)
		process.env.DSH_BACKROOM_SESSION_ALLOW = 'sess-allow-1'
		const waitA = await callAs(routeOf(advancing.routes, 'session'), 'POST', `?key=${KEY}&session=${SID}&wait=turn-end&timeoutMs=8000`, JSON.stringify({ text: 'ping' }))
		assert.equal(waitA.json.ended, true, `实际=${JSON.stringify(waitA.json.after)}`)
		assert.equal(waitA.json.endedClaim, 'yes')
		assert.equal(waitA.json.turnStarted, true)
		assert.equal(waitA.json.assistantResponded, true)
		assert.ok(waitA.json.waitedMs >= 250 && waitA.json.waitedMs < 8000, `waitedMs=${waitA.json.waitedMs}`)
		assert.ok(waitA.json.after.turnCount > waitA.json.before.turnCount, `前后读数=${JSON.stringify(waitA.json.before)} → ${JSON.stringify(waitA.json.after)}`)
		assert.match(waitA.json.note, /turn\/end|完整回合/)

		// 等待档 B：回合起了但 response 一直空 ⇒ 只能说"还没完"，且 timeoutMs 被夹到下限（2 s 就回，不空转）
		let stalledN = 0
		const stalled = makeCtx({ sessionController: {
			async prompt() { return { accepted: true } },
			async projections() { stalledN += 1; return stalledN === 1 ? outlineOf(7) : outlineOf(8, false) },
		} })
		mod.apply(stalled.ctx)
		const waitB = await callAs(routeOf(stalled.routes, 'session'), 'POST', `?key=${KEY}&session=${SID}&wait=turn-end&timeoutMs=1`, JSON.stringify({ text: 'ping' }))
		assert.equal(waitB.json.ended, false)
		assert.equal(waitB.json.turnStarted, true, '回合确实起了')
		assert.equal(waitB.json.assistantResponded, false, 'response 仍空 ⇒ 不许报结束')
		assert.equal(waitB.json.endedClaim, 'not-yet')
		assert.equal(waitB.json.deadlineMs, 2000, `下限夹取失效=${waitB.json.deadlineMs}`)
		assert.match(waitB.json.note, /response 还是空/)

		// 等待档 C：上限夹到 120 s（这一发前进得早，所以不用真等 120 秒就能验夹取）
		let fastN = 7
		const fast = makeCtx({ sessionController: {
			async prompt() { return { accepted: true } },
			async projections() { fastN += 1; return outlineOf(fastN) },
		} })
		mod.apply(fast.ctx)
		const waitC = await callAs(routeOf(fast.routes, 'session'), 'POST', `?key=${KEY}&session=${SID}&wait=turn-end&timeoutMs=999999`, JSON.stringify({ text: 'ping' }))
		assert.equal(waitC.json.deadlineMs, 120000, `上限夹取失效=${waitC.json.deadlineMs}`)
		assert.equal(waitC.json.ended, true)
		assert.ok(waitC.json.waitedMs < 5000, `不该真等满上限：waitedMs=${waitC.json.waitedMs}`)

		// 等待档 D（10-09 桌面端踩到的那一型的夹具化）：投影袋里**没有**数值 lastTurn ⇒
		// 判据读不到必须自报 unreadable，绝不许把"我瞎"写成"它没结束"
		const blind = makeCtx({ sessionController: {
			async prompt() { return { accepted: true } },
			async projections() { return { asOfSeq: 19, values: { title: { text: 'x' }, usage: { tokens: 3 } } } },
		} })
		mod.apply(blind.ctx)
		process.env.DSH_BACKROOM_SESSION_ALLOW = 'sess-allow-1'
		const waitBlind = await callAs(routeOf(blind.routes, 'session'), 'POST', `?key=${KEY}&session=${SID}&wait=turn-end&timeoutMs=1`, JSON.stringify({ text: 'ping' }))
		assert.equal(waitBlind.json.after.readable, false, JSON.stringify(waitBlind.json.after))
		assert.equal(waitBlind.json.endedClaim, 'unreadable', `实际=${waitBlind.json.endedClaim}`)
		assert.equal(waitBlind.json.ended, false)
		assert.match(waitBlind.json.note, /判据读不到/)
		assert.deepEqual(waitBlind.json.after.projectionKeys, ['title', 'usage'], '读不到时要把官面键名交出去，下一个人不必再考古')

		// 降级档：取不到 sessionController 时不许抛，要如实报原因
		const absent = makeCtx({ sessionController: false })
		mod.apply(absent.ctx)
		process.env.DSH_BACKROOM_SESSION_ALLOW = 'sess-allow-1'
		const waitD = await callAs(routeOf(absent.routes, 'session'), 'POST', `?key=${KEY}&session=${SID}`, JSON.stringify({ text: 'ping' }))
		assert.equal(waitD.json.reason, 'no-sessionController')
		assert.equal(waitD.json.ok, false)

		// 拒绝要按原因留痕（不许静默吞）
		assert.ok(sessObs.denied.disabled >= 1 && sessObs.denied['bad-key'] >= 1 && sessObs.denied['not-allowlisted'] >= 1, JSON.stringify(sessObs.denied))
		for (const disposer of [...advancing.effects, ...stalled.effects, ...absent.effects, ...fast.effects]) {
			if (typeof disposer === 'function') await disposer()
			else if (disposer && typeof disposer.dispose === 'function') await disposer.dispose()
		}
		step('会话窄口：5 把闸逐把红过一遍才放行 1 发；官面 request 形状对得上现读；等待带 deadline 与前后读数；取不到服务如实降级')
	} finally {
		delete process.env.DSH_BACKROOM_SESSION_KEY
		delete process.env.DSH_BACKROOM_SESSION_ALLOW
		for (const disposer of fresh.effects) {
			if (typeof disposer === 'function') await disposer()
			else if (disposer && typeof disposer.dispose === 'function') await disposer.dispose()
		}
	}
}

// ── 15. Agent 工具面（本地只能验降级档：本工作区解析不到 @deepseek-ai/dsh-tools，实测 ERR_MODULE_NOT_FOUND）
{
	const settle = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 150)) }
	const disposeAll = async (bag) => {
		for (const d of bag.effects) {
			if (typeof d === 'function') await d()
			else if (d && typeof d.dispose === 'function') await d.dispose()
		}
	}
	const noTools = makeCtx({ tools: false })
	mod.apply(noTools.ctx)
	await settle()
	const st1 = globalThis.__backroomObservations.toolsState
	assert.match(String(st1.status), /^absent/, `没有 tools 服务时应报 absent，实际=${st1.status}`)
	assert.equal(noTools.routes.length, 4, '工具面缺席不许带走那四枚路由')
	assert.equal(st1.registered.length, 0)

	const withTools = makeCtx({})
	mod.apply(withTools.ctx)
	await settle()
	const st2 = globalThis.__backroomObservations.toolsState
	assert.ok(/^import-failed/.test(String(st2.status)) || /^registered\(/.test(String(st2.status)),
		`工具面状态只能是 import-failed 或 registered(n)，实际=${st2.status}`)
	assert.equal(withTools.routes.length, 4, '工具注册失败也不许带走那四枚路由（整包不能被工具面带走）')
	const captured = withTools.ctx.get('tools').__captured
	if (/^import-failed/.test(String(st2.status))) assert.equal(captured.length, 0, 'import 失败时不该有任何一枚被注册')
	await disposeAll(noTools); await disposeAll(withTools)
	step(`Agent 工具面·本地档：无 tools⇒absent、dsh-tools 解析不到⇒如实 import-failed，两种情况四枚路由都照挂（现读=${String(st2.status).slice(0, 30)}；真注册要在装了 dsh-tools 的 profile 里读）`)
}

// ── 16. 工具面里的路径映射与两把白名单闸（纯函数直验，不等真宿主）───────────
{
	assert.equal(mod.mntToWindowsPath('/mnt/e/tmp'), 'E:\\tmp')
	assert.equal(mod.mntToWindowsPath('/mnt/c/Users/x'), 'C:\\Users\\x')
	assert.equal(mod.mntToWindowsPath('/home/ruler/proj'), null, '不是 /mnt 形就该回 null（那支走 UNC）')
	assert.deepEqual(mod.wslTargets('Ubuntu', '/home/ruler/proj'), { target: '\\\\wsl.localhost\\Ubuntu\\home\\ruler\\proj', branch: 'unc' })
	assert.deepEqual(mod.wslTargets('Ubuntu', '/mnt/e/tmp'), { target: 'E:\\tmp', branch: 'mnt-drive' })
	assert.equal(mod.rootGate('', 'E:/x'), 'disabled', '没设名单＝不建，绝不顺手放行')
	assert.equal(mod.rootGate('E:/dsh-plugins;D:/somewhere', 'E:/dsh-plugins/x'), 'ok')
	assert.equal(mod.rootGate('E:/dsh-plugins', 'E:/dsh-plugins'), 'ok', '根本身也算在内')
	assert.equal(mod.rootGate('E:/dsh-plugins', 'C:/Users/whoever/x'), 'outside-roots')
	assert.equal(mod.rootGate('E:/a', 'E:/ab/x'), 'outside-roots', '前缀要按路径段判，E:/ab 不许被 E:/a 放过')
	assert.equal(mod.distroGate('', 'Ubuntu'), 'disabled')
	assert.equal(mod.distroGate('Ubuntu, Debian', 'Ubuntu'), 'ok', '逗号两侧的空格要能吃掉')
	assert.equal(mod.distroGate('Ubuntu', 'calc'), 'not-allowed-distro')
	step('路径映射＋两把白名单闸：/mnt 两支、UNC 拼装、"没设＝disabled"、前缀按路径段判（E:/ab 不算 E:/a 之内）')
}

// ── 13. 红线哨兵（把本窗裁定与这次事故都钉成会抛错的闸）───────────────────
// 先剥注释再扫：本仓 #91 那一条今天咬到了我自己——禁的是**代码里的那一发调用**，
// 而"绝不做 X"这句说明本身写在注释里，不剥就会把说明当违规（假红）。
const codeOnly = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
assert.ok(codeOnly.length < source.length, `剥完注释还剩 ${codeOnly.length}/${source.length} B`)
assert.ok(!/authenticatedUrl\s*\(/.test(codeOnly), '不许调用 authenticatedUrl（钥匙不出本进程）')
assert.ok(!/\bappend\s*\(/.test(codeOnly), '不许 Session.append 自定义事件（PITFALLS #1）')
assert.ok(!/taskkill|process\.kill|child_process|\.exit\s*\(/.test(codeOnly), '插件绝不杀/重启宿主（RULES §E1）')
assert.ok(!/path:\s*'\/api/.test(codeOnly), '不许出现 /api 前缀路由（RULES §C4）')
assert.ok(!/homedir\(\)/.test(codeOnly), '不读用户目录、不写 ~/.dsh（RULES §0）')
assert.ok(!/replace\(\/\\s\+\//.test(codeOnly), '不许对整条日志文本做全局正则（10-04 拖死后端的那一步）')
const consoleMethods = (codeOnly.match(/CONSOLE_METHODS = \[([^\]]*)\]/) || [])[1] || ''
assert.ok(/'error'/.test(consoleMethods) && /'warn'/.test(consoleMethods) && !/'log'/.test(consoleMethods) && !/'info'/.test(consoleMethods), `console 只许包 error/warn，实际=[${consoleMethods}]；加回 log/info 要先过这条闸`)
assert.ok(/RATE_LIMIT = 200/.test(codeOnly), '速率闸默认值改大要留来源注（PITFALLS 那条"阈值不许调到刚好过门"）')
// 10-04 那发的正面凭据是一条栈：`hmr.getLinked()` 在 ESM loader 的 tick 上抛 ⇒ 本端 try/catch 拦不住
// ⇒ 后端 `dsh: fatal load failure` 退出。所以"探针只能问名字，不能动手"必须是会红的闸，不是口头纪律。
for (const forbidden of ['getLinked(', 'watchConfig(', 'runExclusive(', 'runReload(', 'getOuterStack(', 'authenticatedUrl(']) {
	assert.ok(!codeOnly.includes(forbidden), `探针不许调用外来面的方法：出现了 ${forbidden}`)
}
assert.ok(/'not-called/.test(codeOnly), 'hmr 那一格要写成 not-called 的说明串（把这次事故留在码里，不只是文档里）')
// 会话窄口的五把闸也要交给闸，不靠"下次记得"：任一 env 名字从代码里消失＝那把闸被拆了，红。
for (const gate of ['DSH_BACKROOM_SESSION_KEY', 'DSH_BACKROOM_SESSION_ALLOW', 'SESSION_RATE_LIMIT', 'SESSION_TEXT_LIMIT', 'SESSION_BODY_LIMIT', 'SESSION_WAIT_MAX_MS', 'DSH_BACKROOM_WORKSPACE_ROOTS', 'DSH_BACKROOM_WSL_DISTROS']) {
	assert.ok(codeOnly.includes(gate), `会话窄口的闸少了一枚：${gate} 不再出现在代码里`)
}
assert.equal((codeOnly.match(/\.prompt\(/g) || []).length, 1, '官面 prompt 只许有一个调用点（就在窄口 handler 里），探针那枚端点永远不许动它')
assert.ok(/crypto\.randomUUID\(\)/.test(codeOnly), 'requestId 必须自带（官面靠它做幂等去重，少了就会重复入队）')
assert.ok(/timingSafeEqual/.test(codeOnly), 'key 比较必须等时，不许用 ===')
assert.ok(!/session\/create/.test(codeOnly), '绝不调官面 session/create（新建会话由人做，不给插件）')
// 会话那枚面上只许出现这两次方法调用；其余一律红（10-09 加工作区 create 后，旧判据"看见 .create( 就红"会误伤官面工作区创建，
// 所以换成"按哪枚面、调了什么"判：sessionController 面只许 prompt/projections，create 只许出现在工作区那枚面上一次）
const sessionFaceCalls = (codeOnly.match(/\bsc\.[a-zA-Z]+\(/g) || [])
assert.deepEqual([...new Set(sessionFaceCalls)].sort(), ['sc.projections(', 'sc.prompt('], `对会话面调了多余的方法：${JSON.stringify([...new Set(sessionFaceCalls)])}`)
assert.equal((codeOnly.match(/\.create\(/g) || []).length, 1, 'create 只许一处（官面工作区那枚 wc.create）')
assert.ok(/wc\.create\(/.test(codeOnly), '那一处 create 必须是工作区面的 wc.create(')
// PITFALLS #99 的第三次踩到（10-05 写实验靶插件时又写成块体＋当场 dispose）⇒ 交给闸，不靠小心。
// 只许两种形状：`ctx.effect(() => disposer, …)` 或官面那种 `ctx.effect(() => () => {…}, …)`；块体一律红。
const effectShapeGate = /ctx\.effect\(\(\)\s*=>\s*\{/
assert.ok(!effectShapeGate.test(codeOnly), 'ctx.effect 的 body 不许写成块体（块体里就地撤销＝路由 404 而 fiberPhase 仍 active，#99）')
// 正对照：把自家那行退回旧形，闸必须**恰在这一发红**（空闸＝没闸）
const mutated = codeOnly.replace('ctx.effect(() => dispose,', 'ctx.effect(() => { dispose(),')
assert.ok(mutated !== codeOnly, '对照件没替换成功＝这发对照是空的')
assert.ok(effectShapeGate.test(mutated), '退回 #99 旧形时块体闸必须红')
// 官面那一形（块体但返回 disposer）不许被误伤
assert.ok(!effectShapeGate.test("ctx.effect(() => () => { disposed = true }, 'x')"), '官面形状被误伤＝闸太粗')
step('红线哨兵（剥注释后扫代码本体）：不外发 token、不 append、不杀宿主、不占 /api、不做整串正则、console 只包 error/warn、速率默认 200、**外来面只许那三枚白名单方法（会话面只有 prompt/projections、工作区面只有 create 一处）**、ctx.effect 不写块体、**窄口与两把新白名单的 env 名字一枚都不能少**')

// ── 18. WSL 桥基址：0.2.1-rc.2 起端口随机，"猜一个写死的端口"这种默认值必须被闸住 ─────
{
	// 观察到什么才算"自己的 origin"：只认环回，且**不许被后缀骗过去**
	assert.equal(mod.loopbackOrigin('127.0.0.1:2495'), '127.0.0.1:2495')
	assert.equal(mod.loopbackOrigin('Localhost:3080 '), 'localhost:3080', 'Host 头大小写无关、尾部空格要吃掉')
	assert.equal(mod.loopbackOrigin('[::1]:9230'), '[::1]:9230')
	assert.equal(mod.loopbackOrigin('127.0.0.1'), '127.0.0.1', '无端口也算环回')
	assert.equal(mod.loopbackOrigin('evil.example:80'), '', '非环回＝空（否则 Host 头能把插件支去外部主机＝SSRF）')
	assert.equal(mod.loopbackOrigin('127.0.0.1.evil.com'), '', '后缀骗不过去')
	assert.equal(mod.loopbackOrigin('127.0.0.1:2495:9'), '', '畸形端口不认')
	assert.equal(mod.loopbackOrigin(''), '')
	// 三档优先级：env > 观察到 > unknown，且 unknown 那档必须自带"怎么走通"的话
	assert.deepEqual(mod.bridgeBase('http://127.0.0.1:19999', '127.0.0.1:2495'), { base: 'http://127.0.0.1:19999', source: 'env' }, 'env 显式给必须赢')
	assert.deepEqual(mod.bridgeBase('', '127.0.0.1:2495'), { base: 'http://127.0.0.1:2495', source: 'observed-host-header' })
	assert.deepEqual(mod.bridgeBase(undefined, undefined), { base: '', source: 'unknown', reason: mod.bridgeBase(undefined, undefined).reason }, '没 env 也没观察到 ⇒ base 空、source 写 unknown')
	assert.ok(/DSH_BACKROOM_BRIDGE_BASE/.test(mod.bridgeBase('', '').reason), 'unknown 那档必须给可执行的补救（不许只报错不给路）')
	step('桥基址三档（env／观察／unknown）＋环回判定不被后缀骗（127.0.0.1.evil.com 与 evil.example 都回空）')
}
{
	// 闸的落点在代码本体里：不许留"回落到某个写死端口"的默认值。正对照＝把旧形退回去，必须恰在这一发红。
	const hardcoded = /19387|process\.env\.DSH_PORT/
	assert.ok(!hardcoded.test(codeOnly), `代码本体里又出现了写死端口／DSH_PORT 回落：${JSON.stringify((codeOnly.match(/.{0,40}(19387|DSH_PORT).{0,40}/) || [])[0])}`)
	const mutated = codeOnly.replace('bridgeBase(process.env.DSH_BACKROOM_BRIDGE_BASE, selfOrigin)', "bridgeBase(process.env.DSH_BACKROOM_BRIDGE_BASE || `http://127.0.0.1:19387`, selfOrigin)")
	assert.ok(mutated !== codeOnly, '对照件没替换成功＝这发对照是空的')
	assert.ok(hardcoded.test(mutated), '退回"猜 19387"那一形时闸必须红（空闸＝没闸）')
	step('哨兵：本体里不许再有 19387／DSH_PORT 回落（新版端口随机 ⇒ 静默打旧口＝假"桥坏了"），退回旧形的合成件必红')
}

console.log(`\nPASS dsh-backroom probe suite — ${passed} steps, 0 failures（夹具档，非真宿主读数）`)
