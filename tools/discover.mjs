#!/usr/bin/env node
// dsh-backroom — 一条命令的发现工具（11-01 痛点 5）。
//
// 为什么要有：端口随机（0.2.1-rc.2 起）＋ key 在文件 ＋ 路由前缀，新 agent 手写发现逻辑
// 两次、错一次（端口探测一 liner 返回空）。本工具输出一份零猜测的 JSON：
//   { ok, baseUrl, port, pid, backroom, keyFile, key, routes }
// 端口判据与启动器 Find-BackendPort 同源，但比它多一道**正文**校验（11-01 rc.5 实测教训）：
// 同一进程还监听一枚 API-key 网关面（OpenAI 形 401 invalid_api_key，所有路径都回），只看
// 状态码会把 401 兜底判成"后端"——所以 probe-200 必须带 backroom 形状、root-401 必须带
// 官面那句 `dsh web authentication required`。
// 宿主没起 / 找不到后端时：stderr 给人话、stdout 给 JSON（ok:false + reason），退出码 1——
// 绝不空输出、绝不静默。
//
// 跑法：node tools/discover.mjs [--no-key] [--pretty]
//   --no-key  只给 keyFile 路径，不把 key 值打进 stdout（值仍可从文件读）。

import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HARNESS_IMAGE = 'DeepSeek Harness.exe'
const OFFICIAL_401 = 'dsh web authentication required'
const PROBE_TIMEOUT_MS = 1500

const ROUTES = [
	{ method: 'GET', path: '/dsh-backroom/probe', auth: 'none', what: '可达矩阵＋self/loadedPlugins＋计数' },
	{ method: 'GET', path: '/dsh-backroom/logs?limit=&level=&contains=', auth: 'none', what: '日志尾（logger＋console 全五枚）' },
	{ method: 'GET', path: '/dsh-backroom/faults?limit=&dir=', auth: 'none', what: '崩溃件归因' },
	{ method: 'GET', path: '/dsh-backroom/presets', auth: 'none', what: 'agentPreset 名册＋权限档目录＋闸状态' },
	{ method: 'GET', path: '/dsh-backroom/declarations', auth: 'none', what: '每枚 agentPreset 的声明体内文（变体验证看这里）' },
	{ method: 'GET', path: '/dsh-backroom/sessions?key=', auth: 'key', what: '本进程建设账（owned/spend/quota/budget）' },
	{ method: 'POST', path: '/dsh-backroom/sessions?key=', auth: 'key', what: '建会话 / 归档自己建的' },
	{ method: 'GET', path: '/dsh-backroom/session?key=&session=', auth: 'key', what: '读会话回合面' },
	{ method: 'POST', path: '/dsh-backroom/session?key=&session=&wait=turn-end', auth: 'key', what: '往会话发一条 prompt' },
	{ method: 'POST', path: '/dsh-backroom/reload?plugin=<包名>', auth: 'key', what: '按插件热重载（需 hmr 观察根覆盖）' },
]

/** tasklist /FO CSV /NH 的输出 → PID 数组（纯函数，夹具直验）。 */
export function parseTasklistPids(text) {
	const pids = []
	for (const line of String(text || '').split(/\r?\n/)) {
		if (!line.includes('"')) continue
		const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''))
		// CSV 形：映像名,PID,会话名,会话号,…；映像名必须逐字匹配（防蹭名进程）。
		if (cols[0] === HARNESS_IMAGE && /^\d+$/.test(cols[1] || '')) pids.push(Number(cols[1]))
	}
	return [...new Set(pids)]
}

/** netstat -ano -p TCP 的输出 → 该 PID 家族监听的 TCP 端口（纯函数，夹具直验）。 */
export function parseNetstatPorts(text, pids) {
	const family = new Set((Array.isArray(pids) ? pids : []).map(Number))
	const ports = new Set()
	for (const line of String(text || '').split(/\r?\n/)) {
		if (!/LISTENING/i.test(line)) continue
		const cols = line.trim().split(/\s+/)
		// 形：Proto 本地地址 外部地址 状态 PID（IPv6 行本地地址里也有冒号）。
		if (cols.length < 5) continue
		const local = cols[1]
		const pid = Number(cols[cols.length - 1])
		if (!family.has(pid)) continue
		const j = local.lastIndexOf(':')
		if (j < 0) continue
		const port = Number(local.slice(j + 1))
		if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
	}
	return [...ports].sort((a, b) => a - b)
}

/** 探针 200 的正文必须是 backroom 形状（网关面的穿透也会给 200，正文才是身份）。 */
export function isBackroomProbeBody(text) {
	if (!String(text || '').includes('dsh-backroom')) return false
	try {
		const json = JSON.parse(text)
		return json && json.ok === true && json.plugin && json.plugin.plugin === 'dsh-backroom'
	} catch {
		return false
	}
}

/** root 401 的正文必须是官面那一句（rc.5 的 API-key 网关面也回 401，正文不同）。 */
export function isOfficialAuthBody(text) {
	return String(text || '').includes(OFFICIAL_401)
}

function get(url, timeoutMs = PROBE_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false
		const done = (value) => { if (!settled) { settled = true; resolve(value) } }
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			let body = ''
			res.on('data', (c) => { if (body.length < 100_000) body += c })
			res.on('end', () => done({ status: res.statusCode, body }))
			res.on('error', () => done({ status: res.statusCode, body }))
		})
		req.on('timeout', () => { req.destroy(); done({ status: 0, body: '' }) })
		req.on('error', () => done({ status: 0, body: '' }))
	})
}

function keyFileInfo() {
	const file = (typeof process.env.DSH_BACKROOM_KEY_FILE === 'string' && process.env.DSH_BACKROOM_KEY_FILE.trim() !== '')
		? process.env.DSH_BACKROOM_KEY_FILE.trim()
		: path.join(process.env.TEMP || process.env.TMP || '.', 'dsh-backroom-key.txt')
	return { file }
}

// key 的读取用同步 fs（一次性小文件），避免 top-level await 兼容负担。
import { readFileSync } from 'node:fs'
function readKey(file) {
	try { return readFileSync(file, 'utf8').trim() || null } catch { return null }
}

async function discover() {
	const args = process.argv.slice(2)
	const noKey = args.includes('--no-key')
	const pretty = args.includes('--pretty')

	const tasklist = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${HARNESS_IMAGE}`, '/FO', 'CSV', '/NH'], { timeout: 10_000, encoding: 'utf8' })
	const pids = parseTasklistPids(tasklist.status === 0 ? tasklist.stdout : '')
	if (pids.length === 0) {
		const fail = { ok: false, reason: 'host-not-running', hint: `没有 ${HARNESS_IMAGE} 进程。用启动器拉起：powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-desktop-with-mouth.ps1（它会顺带把 key 落盘并打印后端端口）。` }
		console.error(`FAIL: ${fail.reason}`)
		console.log(JSON.stringify(fail, null, pretty ? 2 : 0))
		process.exitCode = 1
		return
	}
	const netstat = spawnSync('netstat', ['-ano', '-p', 'TCP'], { timeout: 10_000, encoding: 'utf8' })
	const ports = parseNetstatPorts(netstat.status === 0 ? netstat.stdout : '', pids)
	let found = null
	for (const port of ports) {
		const probe = await get(`http://127.0.0.1:${port}/dsh-backroom/probe`)
		if (probe.status === 200 && isBackroomProbeBody(probe.body)) { found = { port, backroom: true }; break }
	}
	if (!found) {
		for (const port of ports) {
			const root = await get(`http://127.0.0.1:${port}/`)
			if (root.status === 401 && isOfficialAuthBody(root.body)) { found = { port, backroom: false }; break }
		}
	}
	if (!found) {
		const fail = { ok: false, reason: 'backend-not-found', pids, triedPorts: ports, hint: `PID 家族（${pids.join(',')}）在监听 ${ports.length} 枚口，但没有一枚是 dsh 后端（探针不带 backroom 形状、root 也不回官面那句话）。宿主可能在启动中——等几秒重跑；或这一族里根本没有 web 后端。` }
		console.error(`FAIL: ${fail.reason}`)
		console.log(JSON.stringify(fail, null, pretty ? 2 : 0))
		process.exitCode = 1
		return
	}
	const { file } = keyFileInfo()
	const key = noKey ? null : readKey(file)
	// 11-01 走查补的洞：key 读不到时必须当场说清后果与出路，否则新 agent 会带着 null 去打
	// 动作路由、吃 403、然后开始自行考古——那正是本工具要消灭的循环。
	let note = found.backroom
		? 'probe/presets/logs/faults/declarations 免 key；带 key 的动作路由（sessions/session/reload）三选一递 key：?key= / x-backroom-key 头 / Authorization: Bearer。'
		: '后端在，但 dsh-backroom 不在这个 profile 里（probe 不回 backroom 形状）——只读/动作路由都不存在，先装插件。'
	if (!noKey && key === null) {
		note += ` ⚠ key 文件读不到（${file}）⇒ 动作路由此刻全部 403 disabled：宿主多半是你自己点图标启动的（没带 key env，属预期而非缺陷）。出路＝跑一次启动器（写 key 文件并带 env 重启宿主）：powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-desktop-with-mouth.ps1`
	}
	note += ' 逐条路由的调用格式与每把闸：本包 README 的「给其他 agent 的一页用法」。'
	const out = {
		ok: true,
		baseUrl: `http://127.0.0.1:${found.port}`,
		port: found.port,
		pid: pids[0],
		backroom: found.backroom,
		keyFile: file,
		...(noKey ? {} : { key }),
		routes: ROUTES,
		note,
	}
	console.log(JSON.stringify(out, null, pretty ? 2 : 0))
}

await discover()
