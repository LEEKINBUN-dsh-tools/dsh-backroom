// test/discover.mjs — tools/discover.mjs 的离线套件
//
// 为什么要有：discover 是给"下一个 agent"的第一入口，它的判据错了会成批传染
// （11-01 rc.5 实测：只看状态码的 401 兜底会把 API-key 网关面认成后端）。所以判据
// 函数必须在这里钉死；CLI 实跑那一档做**容错**验收——宿主起没起都要回可解析的
// JSON（起了 ⇒ ok:true+baseUrl；没起 ⇒ ok:false+reason+退出码 1），绝不空输出。
//
// 跑法：node test/discover.mjs （零依赖、零写盘；CLI 实跑一发真进程）

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'tools', 'discover.mjs')

let passed = 0
const step = (label) => {
	passed += 1
	console.log(`  ${String(passed).padStart(2, '0')} ok — ${label}`)
}

const mod = await import(`file:///${tool.replace(/\\/g, '/')}`)

// ── 1. tasklist CSV 解析：逐字匹配映像名 + PID 数字校验 + 去重 ──
{
	const csv = [
		'"DeepSeek Harness.exe","1234","Console","1","100,000 K"',
		'"DeepSeek Harness.exe","1234","Console","1","99,000 K"', // 同 PID 重复
		'"chrome.exe","5555","Console","1","200,000 K"',          // 蹭名进程不许进
		'"DeepSeek Harness.exe","abc","Console","1","1 K"',       // 非 PID 列拒
		'INFO: No tasks are running which match the specified criteria.',
	].join('\r\n')
	assert.deepEqual(mod.parseTasklistPids(csv), [1234])
	assert.deepEqual(mod.parseTasklistPids(''), [])
	step('tasklist CSV：映像名逐字匹配、PID 必须数字、去重、空输出安全')
}

// ── 2. netstat 解析：LISTENING + PID 家族过滤 + IPv6 本地地址 + 非法端口 ──
{
	const netstat = [
		'  Proto  Local Address          Foreign Address        State           PID',
		'  TCP    127.0.0.1:7145         0.0.0.0:0              LISTENING       1234',
		'  TCP    127.0.0.1:8326         0.0.0.0:0              LISTENING       1234',
		'  TCP    [::1]:9230             [::]:0                 LISTENING       1234',
		'  TCP    127.0.0.1:7145         127.0.0.1:5000         ESTABLISHED     1234', // 非 LISTENING
		'  TCP    10.0.0.1:443           0.0.0.0:0              LISTENING       9999',  // 家族外
		'  TCP    0.0.0.0:0              0.0.0.0:0              LISTENING       1234',  // 端口 0 拒
	].join('\r\n')
	assert.deepEqual(mod.parseNetstatPorts(netstat, [1234]), [7145, 8326, 9230])
	assert.deepEqual(mod.parseNetstatPorts(netstat, []), [])
	step('netstat：LISTENING 限定、PID 家族过滤、IPv6 本地地址、端口 0 拒')
}

// ── 3. 正文判据：rc.5 网关面必须被两道正文闸同时挡住 ──
{
	const realProbe = JSON.stringify({ ok: true, plugin: { plugin: 'dsh-backroom', appliedAt: 'x' }, host: {} })
	const gateway401 = JSON.stringify({ error: { message: 'Missing or invalid API key', type: 'authentication_error', code: 'invalid_api_key' } })
	const official401 = 'dsh web authentication required; reopen the URL printed by dsh web.'
	assert.equal(mod.isBackroomProbeBody(realProbe), true)
	assert.equal(mod.isBackroomProbeBody('{"ok":true}'), false, '只有 ok 不够（网关穿透也回 200）')
	assert.equal(mod.isBackroomProbeBody(gateway401), false)
	assert.equal(mod.isOfficialAuthBody(official401), true)
	assert.equal(mod.isOfficialAuthBody(gateway401), false, '网关面的 401 正文不许过官面闸')
	step('正文判据：backroom 形状＋官面 401 句子各各认领；网关面的 invalid_api_key 两道都挡下')
}

// ── 4. CLI 实跑（容错）：宿主起没起都要回可解析 JSON，绝不空输出 ──
{
	let out = ''
	let code = 0
	try {
		out = execFileSync(process.execPath, [tool, '--no-key'], { encoding: 'utf8', timeout: 30_000 })
	} catch (error) {
		out = String(error.stdout || '')
		code = typeof error.status === 'number' ? error.status : 1
	}
	const json = JSON.parse(out.trim().split(/\r?\n/).pop()) // stdout 末行＝JSON（stderr 人话不混入）
	if (json.ok === true) {
		assert.match(json.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
		assert.equal(json.key, undefined, '--no-key 不得把 key 值打进 stdout')
		assert.ok(Array.isArray(json.routes) && json.routes.length >= 8)
		assert.equal(code, 0)
		step(`CLI 实跑：宿主在场 ⇒ ok:true、baseUrl=${json.baseUrl}、backroom=${json.backroom}、routes ${json.routes.length} 枚（--no-key 不带 key 值）`)
	} else {
		assert.equal(json.ok, false)
		assert.ok(['host-not-running', 'backend-not-found'].includes(json.reason), `reason=${json.reason}`)
		assert.ok(typeof json.hint === 'string' && json.hint.length > 10, '失败也要给可执行的路')
		assert.equal(code, 1, '失败退出码 1')
		step(`CLI 实跑：宿主不在场 ⇒ ok:false、reason=${json.reason}、hint 在场、退出码 1（绝不空输出）`)
	}
}

console.log(`\nPASS dsh-backroom discover suite — ${passed} steps, 0 failures`)
