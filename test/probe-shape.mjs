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

function makeCtx({ logger, hmrPresent = true, blockPlanMode = true, sessionController, tools = true, agentPresets, permissionPresets, workspaceController, workspaceRegistry } = {}) {
	const table = new Map()
	// 真宿主同形：`ctx.get('logger')` 取不到（10-04 现读 absent），只有 `ctx.logger` 属性拿得到
	// ⇒ logger 一律**不进名字表**，改成属性 getter，让"属性回退"那半条路真被测到。
	if (hmrPresent) {
		table.set('hmr', { watchConfig() {}, getLinked() { return { linked: ['dsh-backroom'] } } })
	}
	table.set('profileContext', { dir: 'X', patchPath: 'Y' })
	if (tools !== false) table.set('tools', { __captured: [], register(tool) { this.__captured.push(tool); return () => {} } })
	if (sessionController !== false) table.set('sessionController', sessionController || { prompt() {}, follow() {}, list() {} })
	// 10-19 建会话那一档要用的三面（名册／权限档目录／工作区归档通道）：默认**不在场**，
	// 由第 20/21 步逐发塞进去——"取不到就如实 absent、且不带走路由"那一档也要被验到，不能只验 happy path。
	if (agentPresets) table.set('agentPresets', agentPresets)
	if (permissionPresets) table.set('permissionPresets', permissionPresets)
	if (workspaceController) table.set('workspaceController', workspaceController)
	if (workspaceRegistry) table.set('workspaceRegistry', workspaceRegistry)
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
const callAs = async (route, method, url, body, headers) => {
	const res = makeRes()
	const listeners = {}
	const req = { url, method, headers: headers || {}, on(ev, fn) { (listeners[ev] ||= []).push(fn) }, destroy() {} }
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

assert.equal(routes.length, 6, `注册到的路由数=${routes.length}`)
assert.deepEqual(routes.map((r) => r.path).sort(), ['/dsh-backroom/faults', '/dsh-backroom/logs', '/dsh-backroom/presets', '/dsh-backroom/probe', '/dsh-backroom/session', '/dsh-backroom/sessions'])
assert.ok(routes.every((r) => r.path.startsWith('/dsh-backroom/')))
assert.ok(!routes.some((r) => r.path.startsWith('/api')), '绝不占用 /api 前缀（RULES §C4）')
assert.equal(exporters.length, 1, 'ctx.logger.exporter 注册成功')
const obs = globalThis.__backroomObservations
assert.equal(obs.exporterState, 'registered')
assert.equal(obs.routeRegistrations, 6)
assert.equal(obs.mountErrors, 0, `mountErrors=${obs.mountErrors} lastError=${obs.lastError}`)
assert.equal(obs.bufferLenAtRegister, 2, '记下注册时的缓冲长度，用来判"能不能回放"')
assert.equal(obs.loggerFace, 'present-via-property', '真宿主同形：logger 走属性能拿到')
assert.equal(obs.consolePatchState, 'patched(2:error/warn)', `实际=${obs.consolePatchState}`)
assert.notEqual(console.error, originalError, 'console.error 被包')
assert.notEqual(console.warn, originalWarn, 'console.warn 被包')
assert.equal(console.log, originalLog, '10-04 事故后收窄：热路径 console.log/info **不再**被接管')
assert.equal(console.info, originalInfo, 'console.info 保持原样')
step('装载形状：6 枚路由（4 枚只读：probe/logs/faults/presets＋2 枚动手：sessions 建归档／session 发消息，都要 env key，无 /api）＋exporter＋console 只包 error/warn 两枚')

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
assert.equal(degradedBody.plugin.routeRegistrations, 6, '取不到 logger 也要照样把六枚端点挂上（动手那两枚自己按 env 关门）')
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

		// 10-19 尾部：其他 agent 用请求头递 key ⇒ 不许再落成 no-key（这条来自实物反馈：对的 key 也吃 no-key）
		process.env.DSH_BACKROOM_SESSION_KEY = KEY
		process.env.DSH_BACKROOM_SESSION_ALLOW = SID
		process.env.DSH_BACKROOM_KEY_FILE = 'C:/Temp/dsh-backroom-key.txt'
		{
			const hdrCtx = makeCtx({ sessionController: gateFake })
			mod.apply(hdrCtx.ctx)
			const hdrRoute = routeOf(hdrCtx.routes, 'session')
			const h1 = await callAs(hdrRoute, 'POST', `?session=${SID}`, JSON.stringify({ text: 'header key' }), { 'x-backroom-key': KEY })
			assert.equal(h1.status, 200, `请求头带 key 必须放行：${JSON.stringify(h1.json)}`)
			const h2 = await callAs(hdrRoute, 'POST', `?session=${SID}`, JSON.stringify({ text: 'bearer key' }), { authorization: `Bearer ${KEY}` })
			assert.equal(h2.status, 200, `Authorization: Bearer 也必须放行：${JSON.stringify(h2.json)}`)
			const h3 = await callAs(hdrRoute, 'POST', `?session=${SID}`, JSON.stringify({ text: 'x' }), { 'x-backroom-key': 'wrong' })
			assert.equal(h3.json.reason, 'bad-key', '错的 header key 要能分辨成 bad-key（不是 no-key）')
			const h4 = await callAs(hdrRoute, 'POST', `?session=${SID}`, JSON.stringify({ text: 'x' }))
			assert.match(h4.json.hint, /dsh-backroom-key\.txt/, 'no-key 的提示必须告诉他们 key 在哪（keyFile）')
			for (const d of hdrCtx.effects) { if (typeof d === 'function') await d(); else if (d && typeof d.dispose === 'function') await d.dispose() }
		}
		delete process.env.DSH_BACKROOM_KEY_FILE

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
	assert.equal(noTools.routes.length, 6, '工具面缺席不许带走那六枚路由')
	assert.equal(st1.registered.length, 0)

	const withTools = makeCtx({})
	mod.apply(withTools.ctx)
	await settle()
	const st2 = globalThis.__backroomObservations.toolsState
	assert.ok(/^import-failed/.test(String(st2.status)) || /^registered\(/.test(String(st2.status)),
		`工具面状态只能是 import-failed 或 registered(n)，实际=${st2.status}`)
	assert.equal(withTools.routes.length, 6, '工具注册失败也不许带走那六枚路由（整包不能被工具面带走）')
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
	if (process.platform === 'win32') {
		// 10-30 实测：工作区记录里是小写盘符，roots 按人习惯写大写 ⇒ 逐字比会误判成越界
		assert.equal(mod.rootGate('D:\\Temp\\issue129-real', 'd:\\temp\\issue129-real\\fixture-ws'), 'ok', 'win32 上大小写要折叠')
		assert.equal(mod.rootGate('d:\\temp', 'D:\\TEMP\\x'), 'ok', '两个方向都要折叠')
		assert.equal(mod.rootGate('D:\\Temp\\issue129-real', 'D:\\Temp\\issue129-real2'), 'outside-roots', '折叠之后仍按路径段判')
	}
	assert.equal(mod.distroGate('', 'Ubuntu'), 'disabled')
	assert.equal(mod.distroGate('Ubuntu, Debian', 'Ubuntu'), 'ok', '逗号两侧的空格要能吃掉')
	assert.equal(mod.distroGate('Ubuntu', 'calc'), 'not-allowed-distro')
	// 10-30：workspaceId 那一支会遇到 UNC 路径（WSL 工作区），白名单判定必须把反斜杠归一后再比
	assert.equal(mod.rootGate('\\\\wsl.localhost\\Ubuntu', '//wsl.localhost/Ubuntu/home/ruler'), 'ok', 'UNC 工作区路径要能被同一条根放行')
	assert.equal(mod.rootGate('\\\\wsl.localhost\\Ubuntu', '//wsl.localhost/Ubuntu2/home/x'), 'outside-roots', '按路径段判，Ubuntu2 不算 Ubuntu 之内')
	step('路径映射＋两把白名单闸：/mnt 两支、UNC 拼装、"没设＝disabled"、前缀按路径段判（E:/ab 不算 E:/a 之内；UNC 工作区同形）')
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
// 10-19 用户改判「不需要切换模型，其他做完」⇒ 名单里加上建会话那一档的四把新闸（少一枚就红，同旧形状）。
for (const gate of ['DSH_BACKROOM_SESSION_KEY', 'DSH_BACKROOM_SESSION_ALLOW', 'SESSION_RATE_LIMIT', 'SESSION_TEXT_LIMIT', 'SESSION_BODY_LIMIT', 'SESSION_WAIT_MAX_MS', 'DSH_BACKROOM_WORKSPACE_ROOTS', 'DSH_BACKROOM_WSL_DISTROS', 'DSH_BACKROOM_MAX_SESSIONS_PER_HOUR', 'DSH_BACKROOM_TOKEN_BUDGET', 'DSH_BACKROOM_ALLOW_PRESETS', 'DSH_BACKROOM_DENY_PRESETS', 'DSH_BACKROOM_KEY_FILE']) {
	assert.ok(codeOnly.includes(gate), `窄口／建会话的闸少了一枚：${gate} 不再出现在代码里`)
}
assert.equal((codeOnly.match(/\.prompt\(/g) || []).length, 1, '官面 prompt 只许有一个调用点（就在窄口 handler 里），探针那枚端点永远不许动它')
assert.ok(/crypto\.randomUUID\(\)/.test(codeOnly), 'requestId 必须自带（官面靠它做幂等去重，少了就会重复入队）')
assert.ok(/timingSafeEqual/.test(codeOnly), 'key 比较必须等时，不许用 ===')
// 10-19 改判：旧哨兵写的是"绝不允许出现 session/create"，用户裁定换成**逐面白名单**＋owned 边界。
// 判据从"看见 .create( 就红"换成"哪一枚面、调了哪一枚方法"——名字仍然一枚都不许多（这条替换的动因见 README「约束换轴」一节）。
const FACE_ALLOWED = {
	sc: ['create', 'prompt', 'projections', 'rename'], // 会话面：建／发／读／打标题
	wc: ['create', 'archiveSession', 'unarchiveSession'], // 工作区面：建工作区（10-09）＋收回自己造的会话（10-19）
	ap: ['list'], // 预设名册面：只许读名册（defaultId 是 getter，不带括号）
	pp: ['catalog'], // 权限档面：**只许读 catalog**，改档一律红
	wr: ['get', 'list'], // 工作区注册面：只许按 id 取/列（10-19 加 workspaceId 那一支要用它拿路径判白名单）
}
const faceMethods = (code, alias) => [...new Set([...code.matchAll(new RegExp(`\\b${alias}\\.([a-zA-Z]+)\\(`, 'g'))].map((m) => m[1]))]
for (const [alias, allowed] of Object.entries(FACE_ALLOWED)) {
	const seen = faceMethods(codeOnly, alias)
	const extras = seen.filter((m) => !allowed.includes(m))
	assert.deepEqual(extras, [], `${alias} 面上调了白名单外的方法：${JSON.stringify(seen)}（允许 ${JSON.stringify(allowed)}）`)
}
assert.ok(!/pp\.set\(/.test(codeOnly) && !/permissionPresets\.set\(/.test(codeOnly), '权限档只许读不许改：出现 set 即红（"不许放宽档"这一条不靠自觉）')
assert.ok(!/ap\.select\(/.test(codeOnly), '官面 select 是"改**活会话**的档位"，本插件只在新建时带 agentPreset ⇒ 出现即红')
// owned 边界：归档/取消归档必须先证这枚会话是本插件建的（否则"收回去"会变成动用户的会话）
assert.ok(/if \(!ownedIds\.has\(sessionId\)\) return sendJson\(res, 403/.test(codeOnly), '归档那两枚方法前必须有 owned 闸（不在 owned 里就 403 not-owned）')
assert.equal((codeOnly.match(/\.create\(/g) || []).length, 2, 'create 只许两处：工作区面 wc.create 与会话面 sc.create')
assert.ok(/wc\.create\(/.test(codeOnly) && /sc\.create\(/.test(codeOnly), '那两处必须分别是 wc.create 与 sc.create')
// 发现性：其他 agent 不会主动猜"dsh 里有个调试入口" ⇒ 工具面里必须有一枚只读入口卡（工具名是它们每轮看得见的东西）
assert.ok(/name: 'backroom_entry'/.test(codeOnly), '工具面少了一枚 backroom_entry（入口卡）：没有它，别的 agent 不会主动发现这枚插件')
// link 形态下 Node 按 realpath 解析 ⇒ 裸 import '@deepseek-ai/dsh-tools' 会从源码树往上找而失败（10-30 真宿主）
assert.ok(/pathToFileURL\(candidate\)\.href/.test(codeOnly), '工具面要有"从宿主安装根兜底解析 defineTool"的一条路')
// 阈值不许被调到刚好过门：这两枚默认数各有实测标度，动它们要带新数据（注释里就得写着来源）
assert.ok(/SESSION_CREATE_LIMIT_PER_HOUR = 3/.test(codeOnly), '建会话名额默认＝3，改要带新的实测来源')
assert.ok(/SESSION_BUDGET_TOKENS_PER_HOUR = 60_000/.test(codeOnly), '预算默认＝60,000 token（实测 14,920/回合 ×4），改要带新的实测来源')
// 正对照（空闸＝没闸）：把白名单外的方法塞回去，逐面必须**恰在这一发红**
const mutatedSelect = codeOnly.replace('await sc.projections(', 'await sc.cancel(')
assert.ok(mutatedSelect !== codeOnly, '对照件没替换成功＝这发对照是空的')
{
	const seen = faceMethods(mutatedSelect, 'sc')
	assert.ok(seen.includes('cancel'), '对照件里 cancel 没出现＝这发对照打偏（换成真代码里不存在的那一发了）')
	assert.ok(!FACE_ALLOWED.sc.includes('cancel'), '会话面白名单必须不包含 cancel')
}
{
	const mutatedSet = codeOnly.replace('pp.catalog()', 'pp.set(sessionId, "danger-full-access")')
	assert.ok(mutatedSet !== codeOnly, '对照件没替换成功（pp.catalog() 不在了？）＝这发对照是空的')
	assert.ok(/pp\.set\(/.test(mutatedSet), '退回"改权限档"那一形时档位闸必须红')
}
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
step('红线哨兵（剥注释后扫代码本体）：不外发 token、不 append、不杀宿主、不占 /api、不做整串正则、console 只包 error/warn、速率默认 200、**四面逐面白名单（sc＝create/prompt/projections/rename、wc＝create/archiveSession/unarchiveSession、ap＝只 list、pp＝只 catalog ⇒ 改权限档与改活会话档位一律红）**、归档前必须有 owned 闸、create 恰两处、两枚阈值带实测标度、ctx.effect 不写块体、**窄口与建会话的 12 枚 env 名字一枚都不能少**，另含两发合成负对照（塞回 cancel／pp.set 必须红）')

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

// ── 20. 建会话那一档（10-19 用户改判「不需要切换模型，其他做完」）：六把闸逐把红过一遍才放行 ──
{
	const ENVS = ['DSH_BACKROOM_SESSION_KEY', 'DSH_BACKROOM_SESSION_ALLOW', 'DSH_BACKROOM_WORKSPACE_ROOTS', 'DSH_BACKROOM_MAX_SESSIONS_PER_HOUR', 'DSH_BACKROOM_TOKEN_BUDGET', 'DSH_BACKROOM_ALLOW_PRESETS', 'DSH_BACKROOM_DENY_PRESETS']
	const saved = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]))
	// 名册里有激活失败的那一枚（官面 list 的自陈就是"Every current declaration, including activation failures"）
	const ROSTER = [{ id: 'standard', name: '标准' }, { id: 'ptc', name: 'PTC' }, { id: 'cordis', name: '创造', broken: 'activation failed: missing module' }]
	const boot = ({ env = {}, roster = ROSTER, spend = 0, presetValue = 'standard', renameThrows = false, noPresets = false, workspaces = null, createThrows = null } = {}) => {
		for (const k of ENVS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
		const calls = []
		const sc = {
			async create(request) {
				calls.push({ m: 'create', request })
				// "created but could not attach" 那一形（10-30 真宿主原文）：会话先落盘、attach 才失败
				if (createThrows === 'attach') {
					const w = Array.isArray(workspaces) ? workspaces.find((x) => x.workspaceId === request.workspaceId) : null
					if (w) w.sessionIds = [...(w.sessionIds || []), 'sess-orphan-1']
					throw Object.assign(new Error('session "sess-orphan-1" was created but could not attach to workspace'), { code: 'workspace/attach-failed' })
				}
				if (createThrows === 'plain') throw Object.assign(new Error('create refused'), { code: 'session/invalid' })
				return { sessionId: 'sess-new-9', ...(typeof request.agentPreset === 'string' ? { agentPreset: request.agentPreset } : {}) }
			},
			async rename(request) { calls.push({ m: 'rename', request }); if (renameThrows) throw Object.assign(new Error('not resumed'), { code: 'session/not-found' }); return {} },
			async prompt(request, signal) { calls.push({ m: 'prompt', request, hasSignal: Boolean(signal) }); return { accepted: true } },
			async projections() {
				return {
					asOfSeq: 5,
					values: {
						turnOutline: [], sessionStats: { turns: 0 }, modelSelection: null,
						permissions: { currentValue: presetValue },
						tokenUsage: { uncachedInputTokens: spend, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
					},
				}
			},
		}
		const made = makeCtx({
			sessionController: sc,
			agentPresets: noPresets ? undefined : { list: async () => roster, defaultId: 'standard' },
			// 假 catalog 用**本机实测那一形**：defaultPreset 就是最宽那一档（第 20 步要验的正是"这一格会被回显出来"）
			permissionPresets: { names: ['standard', 'danger-full-access'], catalog: () => ({ options: [{ value: 'standard', name: '标准' }, { value: 'danger-full-access', name: 'danger-full-access' }], defaultPreset: 'danger-full-access' }) },
			workspaceRegistry: workspaces === null ? undefined : {
				async get(id) { return workspaces.find((w) => w.workspaceId === id) || null },
				async list() { return workspaces },
			},
			workspaceController: {
				// 官面这一发回的是**整个归档集**（真宿主实测 12 枚，含用户早就归档掉的 11 枚），
				// 夹具也按这一形回，否则"我归档了几枚"会被读成"归档集有几枚"（10-19 真宿主那发就是这么露出来的）
				async archiveSession(q) { calls.push({ m: 'archive', q }); return { archivedSessionIds: ['someone-elses-already-archived', q.sessionId] } },
				async unarchiveSession(q) { calls.push({ m: 'unarchive', q }); return { archivedSessionIds: [] } },
			},
		})
		mod.apply(made.ctx)
		return {
			calls, obs: globalThis.__backroomObservations,
			sessions: routeOf(made.routes, 'sessions'), session: routeOf(made.routes, 'session'), presets: routeOf(made.routes, 'presets'),
		}
	}
	const KEY = 'k'
	const post = (route, qs, body) => callAs(route, 'POST', qs, body)
	const goodEnv = { 'DSH_BACKROOM_SESSION_KEY': KEY, 'DSH_BACKROOM_WORKSPACE_ROOTS': 'D:/Temp' }
	try {
		// 闸 0：没 key ⇒ 整枚端点等于不存在，且官面 create 一枚都不许被调到
		let f = boot({ env: {} })
		let r = await post(f.sessions, '?', JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.json.reason, 'disabled')
		assert.equal(f.calls.length, 0, '没放行之前官面 create 一枚都不该被调到')

		// 闸 A 范围：roots 没设＝建会话整格 disabled；越界的 cwd 单独拒；两种失败都**要退回名额**
		f = boot({ env: { DSH_BACKROOM_SESSION_KEY: KEY } })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.status, 403)
		assert.equal(r.json.reason, 'no-create-roots')
		let ledger = await callAs(f.sessions, 'GET', `?key=${KEY}`)
		assert.equal(ledger.json.quota.used, 0, '失败的那一发必须把名额退回（一次越界不许白吃一小时）')
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_WORKSPACE_ROOTS': 'E:/only-here' } })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.json.reason, 'cwd-outside-roots')
		assert.equal(f.calls.length, 0, '越界的一发不许打到官面')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ caller: 'x' }))
		assert.equal(r.json.reason, 'no-cwd', '不收 workspaceId：只认"目录由这枚会话自己拥有"那一支，白名单才判得动')

		// 闸 B 名册：读不到名册就**不建**（不许猜档位名）；名册外／激活失败／二次名单外，三档各回各话
		f = boot({ env: goodEnv, noPresets: true })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', agentPreset: 'standard', caller: 'x' }))
		assert.equal(r.status, 502)
		assert.equal(r.json.reason, 'roster-unavailable')
		f = boot({ env: goodEnv })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', agentPreset: 'nope', caller: 'x' }))
		assert.equal(r.json.reason, 'not-in-roster')
		assert.deepEqual(r.json.roster, ['standard', 'ptc', 'cordis'], '拒的时候要回名册，让下一个人不用再去猜')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', agentPreset: 'cordis', caller: 'x' }))
		assert.equal(r.json.reason, 'broken-preset', '带 broken 的那一枚是激活失败的，不许建')
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_ALLOW_PRESETS': 'standard' } })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', agentPreset: 'ptc', caller: 'x' }))
		assert.equal(r.json.reason, 'not-allowed-preset')

		// 闸 B'（10-30 加）：workspaceId 那一支——"绑定工作区"类测试要的是它，不是 cwd
		f = boot({ env: goodEnv, workspaces: [{ workspaceId: 'ws-in', path: 'D:/Temp/proj-a' }, { workspaceId: 'ws-out', path: 'E:/elsewhere' }] })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ workspaceId: 'ws-missing' }))
		assert.equal(r.status, 404)
		assert.equal(r.json.reason, 'workspace-not-found')
		ledger = await callAs(f.sessions, 'GET', `?key=${KEY}`)
		assert.equal(ledger.json.quota.used, 0, 'workspace 找不到也要把名额退回')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ workspaceId: 'ws-out' }))
		assert.equal(r.status, 403)
		assert.equal(r.json.reason, 'cwd-outside-roots', 'workspaceId 也要按它那条路径过白名单，绝不因为"它已在工作区列表里"就放行')
		assert.equal(r.json.workspacePath, 'E:/elsewhere')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', workspaceId: 'ws-in' }))
		assert.equal(r.status, 400)
		assert.equal(r.json.reason, 'cwd-and-workspace-id', '两个都给＝官面互斥，要拒')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ workspaceId: 'ws-in', agentPreset: 'standard', caller: 'ws' }))
		assert.equal(r.status, 200, `workspaceId 那一支该放行：${JSON.stringify(r.json)}`)
		assert.deepEqual(f.calls.filter((c) => c.m === 'create').pop().request, { agentPreset: 'standard', workspaceId: 'ws-in' }, 'workspaceId 那一支不许把 cwd 也塞进 request')
		assert.equal(r.json.joinedWorkspaceId, 'ws-in')
		assert.equal(r.json.ownedCwd, null)

		// 10-30 真宿主那一形：会话先落盘、attach 才失败（路径大小写不一致）⇒ 失败回包必须点名孤儿会话，
		// 而 owned 账必须仍是干净的（本插件不认领它、也不替它归档）
		f = boot({ env: goodEnv, createThrows: 'attach', workspaces: [{ workspaceId: 'ws-in', path: 'D:/Temp/proj-a', sessionIds: ['sess-old'] }] })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ workspaceId: 'ws-in', agentPreset: 'standard', caller: 'x' }))
		assert.equal(r.status, 502)
		assert.equal(r.json.orphanSessionId, 'sess-orphan-1', 'attach 失败留下的那枚必须被点名（否则侧栏里多一枚无人认领的）')
		assert.match(r.json.hint, /orphanSessionId/, '提示要说明它不在本插件账上')
		ledger = await callAs(f.sessions, 'GET', `?key=${KEY}`)
		assert.deepEqual(ledger.json.owned, [], '孤儿不许混进 owned')
		f = boot({ env: goodEnv, createThrows: 'plain', workspaces: [{ workspaceId: 'ws-in', path: 'D:/Temp/proj-a', sessionIds: ['sess-old'] }] })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ workspaceId: 'ws-in', agentPreset: 'standard', caller: 'x' }))
		assert.equal(r.status, 502)
		assert.equal('orphanSessionId' in r.json, false, '没有新会话时不许编一个 id 出来')

		// 闸 C 名额：默认 3/小时；用完就 429，且不碰官面
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_MAX_SESSIONS_PER_HOUR': '1' } })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.status, 200, `第一发该放行：${JSON.stringify(r.json)}`)
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/b', caller: 'x' }))
		assert.equal(r.status, 429)
		assert.equal(r.json.reason, 'quota-exceeded')

		// 闸 D 预算：本插件已建会话的累计 token 到顶 ⇒ 建第二发拒、往里发也拒
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_TOKEN_BUDGET': '100' }, spend: 500 })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.status, 200)
		// 账本 GET 必须**先刷再报**：真宿主抓到过"发完一问账本还是 0"那一格（spendTokens 只在 create 时算过一次）
		const ledgerNow = await callAs(f.sessions, 'GET', `?key=${KEY}`)
		assert.equal(ledgerNow.json.spendTokens, 500, `GET 账本要把花费刷成现读值，实际=${JSON.stringify(ledgerNow.json)}`)
		assert.ok(ledgerNow.json.lastSpendReadAt, '花费读数是哪一刻读的也要一起给')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/b', caller: 'x' }))
		assert.equal(r.json.reason, 'budget-exceeded')
		assert.equal(r.json.spentTokens, 500)
		assert.equal(r.json.limitTokens, 100)
		r = await post(f.session, `?key=${KEY}&session=sess-new-9`, JSON.stringify({ text: '再一发' }))
		assert.equal(r.json.reason, 'budget-exceeded', '预算对"自己建的会话"两头都拦：既不再建，也不再往里发')

		// 闸 E 档位：**默认名单为空 ⇒ 只回显不拦**（本机官面默认档实测就是 danger-full-access，拦它＝新建全废）；
		// 点名禁止之后才拒"往里发"。改档这一手本插件做不到（哨兵禁 pp.set），所以"不放宽"是结构性的。
		f = boot({ env: { ...goodEnv }, presetValue: 'danger-full-access' })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.json.permissionGate, 'ok', '没点名禁止名单时不许自作主张地拦')
		assert.equal(r.json.permissionPreset, 'danger-full-access', '但必须把实际生效档**逐发回显**出来')
		assert.equal(r.json.officialDefaultPermission, 'danger-full-access', '这台机器的官面默认档也要一起回显')
		r = await post(f.session, `?key=${KEY}&session=sess-new-9`, JSON.stringify({ text: '发一发' }))
		assert.equal(r.status, 200, '默认名单为空时这一发要能进去（只回显不拦）')
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_DENY_PRESETS': 'danger-full-access' }, presetValue: 'danger-full-access' })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		assert.equal(r.json.permissionGate, 'denied-preset', '点名之后建完的读数就要报出判决（不等到发消息才说）')
		r = await post(f.session, `?key=${KEY}&session=sess-new-9`, JSON.stringify({ text: '发一发' }))
		assert.equal(r.status, 403, '点名禁止之后，"往里发"必须被档位闸拦下')
		assert.equal(r.json.reason, 'denied-preset')
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_DENY_PRESETS': '' }, presetValue: 'danger-full-access' })
		await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		r = await post(f.session, `?key=${KEY}&session=sess-new-9`, JSON.stringify({ text: '发一发' }))
		assert.equal(r.status, 200, `显式清空禁止名单＝这一档放开：${JSON.stringify(r.json)}`)
		// 读不到档位（未 seed 的会话）＝**只报不拦**：把"我没读到"当"它危险"就是端口那一格的复刻
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_DENY_PRESETS': 'danger-full-access' }, presetValue: null })
		await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/a', caller: 'x' }))
		r = await post(f.session, `?key=${KEY}&session=sess-new-9`, JSON.stringify({ text: '发一发' }))
		assert.equal(r.status, 200)
		assert.equal(r.json.permissionGate, 'unknown-preset')

		// 放行那一发的完整形状：官面 create 收到 {cwd, agentPreset}，标题带调用方，owned 自动进窄口名单
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_TOKEN_BUDGET': '60000' } })
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/proj', agentPreset: 'standard', caller: 'orchestrator' }))
		assert.equal(r.status, 200, `实际=${JSON.stringify(r.json)}`)
		assert.equal(r.json.sessionId, 'sess-new-9')
		assert.equal(r.json.agentPreset, 'standard')
		assert.equal(r.json.titleState.ok, true)
		assert.equal(f.calls.find((c) => c.m === 'create').request.cwd, 'D:/Temp/proj', 'cwd 走 path.resolve＋正斜杠那一形递过去（白名单判的就是这一形）')
		assert.equal(f.calls.find((c) => c.m === 'rename').request.title, 'backroom:orchestrator')
		// 没改 env 名单，也能往**自己刚建的那枚**发（owned 自动放行；别人的会话仍然要 env）
		r = await post(f.session, `?key=${KEY}&session=sess-new-9&mode=steer`, JSON.stringify({ text: '插一句' }))
		assert.equal(r.status, 200)
		assert.equal(r.json.mode, 'steer')
		assert.equal(f.calls.filter((c) => c.m === 'prompt')[0].request.mode, 'steer', '档位要原样递进官面 request（enum 现读＝queue|steer）')
		r = await post(f.session, `?key=${KEY}&session=sess-new-9&mode=bogus`, JSON.stringify({ text: 'x' }))
		assert.equal(r.status, 400)
		assert.equal(r.json.reason, 'bad-mode')
		r = await post(f.session, `?key=${KEY}&session=someone-elses`, JSON.stringify({ text: 'x' }))
		assert.equal(r.json.reason, 'no-allowlist', 'env 名单没设时，别人开的会话一枚都动不了——owned 不外扩')
		process.env.DSH_BACKROOM_SESSION_ALLOW = 'sess-other-1'
		r = await post(f.session, `?key=${KEY}&session=someone-elses`, JSON.stringify({ text: 'x' }))
		assert.equal(r.json.reason, 'not-allowlisted', '名单设了但不含它 ⇒ 另一枚原因，两档不许混成一格')

		// 收回：只准收自己造的；收回去之后 owned 不再放行（"我造的才准我动"两头都验）
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ op: 'archive', sessionId: 'someone-elses' }))
		assert.equal(r.status, 403)
		assert.equal(r.json.reason, 'not-owned')
		r = await post(f.sessions, `?key=${KEY}`, JSON.stringify({ op: 'archive', sessionId: 'sess-new-9' }))
		assert.equal(r.status, 200)
		assert.equal(r.json.archivedNow, true, '回包必须自己算出"刚收的那一枚在不在归档集里"')
		assert.equal(r.json.archivedSetSize, 2, '归档集里那一枚别人的不许被算成我收的')
		assert.match(r.json.note, /不是删除/, '回包必须写明"归档＝隐藏"，不许冒充清干净')
		r = await post(f.session, `?key=${KEY}&session=sess-new-9`, JSON.stringify({ text: 'x' }))
		assert.equal(r.json.reason, 'not-allowlisted', '归档后 owned 撤了，本插件不再认这枚')
		// 同一把 key 的另外两种递法在建会话端点上也要成立（其他 agent 默认写 header，不写查询串）
		f = boot({ env: goodEnv })
		r = await callAs(f.sessions, 'POST', '', JSON.stringify({ cwd: 'D:/Temp/hdr', caller: 'hdr' }), { 'x-backroom-key': KEY })
		assert.equal(r.status, 200, `sessions 端点也要收请求头 key：${JSON.stringify(r.json)}`)
		const hdr2 = boot({ env: goodEnv })
		r = await callAs(hdr2.sessions, 'POST', '', JSON.stringify({ cwd: 'D:/Temp/hdr', caller: 'hdr' }), { authorization: `Bearer ${KEY}` })
		assert.equal(r.status, 200, `Bearer 那一形也要成立：${JSON.stringify(r.json)}`)

		// 拒绝按原因分档计数要留痕（不是只回一句 403）
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_MAX_SESSIONS_PER_HOUR': '1' } })
		await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/x' }))
		await post(f.sessions, `?key=${KEY}`, JSON.stringify({ cwd: 'D:/Temp/y' }))
		assert.equal(f.obs.session.denied['quota-exceeded'], 1, `拒绝账没记上：${JSON.stringify(f.obs.session.denied)}`)
		step('建会话那一档：key／范围／名册／名额／预算／档位六把闸逐把红过一遍才放行；owned 自动进窄口、归档后自动出局；每发拒绝都分原因留痕')

		// presets 只读档：名册、默认档位、以及**当前几把闸的状态**都要报出来（不写死档位名的实物凭据）
		f = boot({ env: { ...goodEnv, 'DSH_BACKROOM_ALLOW_PRESETS': 'standard' } })
		const p = await callAs(f.presets, 'GET', '?')
		assert.equal(p.status, 200)
		assert.deepEqual(p.json.agentPresets.presets.map((x) => x.id), ['standard', 'ptc', 'cordis'])
		assert.equal(p.json.agentPresets.presets[2].broken, 'activation failed: missing module', '激活失败那枚要带原因回，别藏')
		assert.equal(p.json.agentPresets.defaultId, 'standard')
		// 发现性：名册这一发要顺手把"两枚动手端点怎么带 key、key 在哪"交出去（否则下一个人继续吃 no-key）
		assert.deepEqual(p.json.auth.schemes, ['?key=<k>', 'header x-backroom-key: <k>', 'header Authorization: Bearer <k>'])
		assert.equal(p.json.auth.envName, 'DSH_BACKROOM_SESSION_KEY')
		assert.equal(p.json.permissionPresets.defaultPreset, 'danger-full-access')
		assert.match(p.json.permissionWarning, /官面默认权限档/, '官面默认档是最宽那一枚时，presets 端点要主动把这句提醒说出来')
		assert.equal(p.json.gates.createRoots, 'set')
		assert.equal(p.status, 200, 'presets 端点不要 key（只读名册，改动一律走另两枚）')
		f = boot({ env: {}, noPresets: true })
		const p2 = await callAs(f.presets, 'GET', '?')
		assert.equal(p2.json.agentPresets.face, 'absent', '取不到名册要如实 absent，不许顶一份内置清单')
		step('presets 只读档：名册＋默认档位＋闸状态三项同框；名册取不到就写 absent')
	} finally {
		for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
	}
}

// ── 21. 建会话那一档的判定式（纯函数直验，含名额退回与档位闸的两副面孔）───────────
{
	assert.equal(mod.presetGate([{ id: 'a' }], 'a', ''), 'ok')
	assert.equal(mod.presetGate([{ id: 'a', broken: 'boom' }], 'a', ''), 'broken-preset')
	assert.equal(mod.presetGate([{ id: 'a' }], 'b', ''), 'not-in-roster')
	assert.equal(mod.presetGate(null, 'a', ''), 'roster-unavailable', '名册读不到绝不能当成"通过"')
	assert.equal(mod.presetGate([{ id: 'a' }, { id: 'b' }], 'b', 'a'), 'not-allowed-preset', '二次白名单设了就生效')
	assert.equal(mod.presetGate([{ id: 'a' }], 'a', 'a'), 'ok')

	const w = mod.hourWindow(2)
	assert.equal(w.take(1000).ok, true)
	assert.equal(w.take(2000).ok, true)
	assert.equal(w.take(3000).ok, false, '窗口内第三发必须拒')
	assert.equal(w.undo(3000).used, 1, 'undo 要把刚占的那格退回（否则一次失败白吃一小时）')
	assert.equal(w.take(3000).ok, true, '退回了就该还能再占')
	assert.equal(w.peek(4000).used, 2)
	const expired = mod.hourWindow(1)
	expired.take(0)
	assert.equal(expired.peek(3_600_001).used, 0, '窗口滑过就该清零')
	const nolimit = mod.hourWindow(0)
	assert.equal(nolimit.take(0).ok, true, 'limit=0＝不设名额（不是"一枚都不许"，别和 disabled 混）')

	assert.equal(mod.budgetGate(10, 0).verdict, 'unbounded', '上限 0＝不限，不是"全部拒"')
	assert.equal(mod.budgetGate(99, 100).verdict, 'ok')
	assert.equal(mod.budgetGate(100, 100).verdict, 'budget-exceeded', '到顶就拒（>=，不留"刚好等于还放行"的缝）')

	assert.equal(mod.denyGate('standard', ''), 'ok')
	assert.equal(mod.denyGate('danger-full-access', ''), 'ok', '显式清空名单＝放开（要放开的人自己点名）')
	assert.equal(mod.denyGate('danger-full-access', undefined), 'ok', 'env 没设＝默认不拦——本机官面默认档就是 danger-full-access，拦它等于新建的会话全废（10-19 实测改判）')
	assert.equal(mod.denyGate('danger-full-access', 'danger-full-access'), 'denied-preset', '点名了才拦')
	assert.equal(mod.denyGate('danger-full-access', 'danger-full-access;other'), 'denied-preset', '分隔符两种都吃')
	assert.equal(mod.denyGate('workspace-write', 'danger-full-access'), 'ok', '不在名单里的档不许被误伤')
	assert.equal(mod.denyGate(null, 'danger-full-access'), 'unknown-preset', '读不到值要单独一档，不许与"被禁"混成一格')

	assert.deepEqual(mod.callerMarker('orchestrator'), { ok: true, title: 'backroom:orchestrator', caller: 'orchestrator' })
	assert.equal(mod.callerMarker('  ').ok, false, '空调用方＝拒，不能建出一枚无主的')
	{
		const weird = mod.callerMarker('../../etc:passwd')
		assert.equal(weird.ok, true)
		assert.ok(!/[\/\\:]/.test(weird.caller), `消毒后调用方名里不许留路径/冒号字符：${weird.caller}`)
		assert.ok(!weird.caller.includes('..'), '不许留 `..` 这种形状（标题会进侧栏，也会被抄进别的脚本）')
		assert.ok(weird.title.startsWith('backroom:') && weird.title === `backroom:${weird.caller}`, '标题＝固定前缀＋消毒后的名字，别自创形状')
	}
	assert.equal(mod.callerMarker('x'.repeat(90)).caller.length, 40, '调用方名字封顶 40')

	assert.equal(mod.tokenSpend({ uncachedInputTokens: 13760, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }), 13762, '四枚桶求和＝本窗实测第一回合那个数')
	assert.equal(mod.tokenSpend(null), 0)
	assert.equal(mod.tokenSpend({ outputTokens: 'x', uncachedInputTokens: 5 }), 5, '非数值的桶跳过，不 NaN')
	step('判定式直验：名册三档、名额窗口与 undo、预算 >=、档位两副面孔（被禁／读不到）、调用方封顶与消毒、token 四桶求和')
}

console.log(`\nPASS dsh-backroom probe suite — ${passed} steps, 0 failures（夹具档，非真宿主读数）`)
