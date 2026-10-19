#!/usr/bin/env node
// dsh-backroom/tools/fault-triage.mjs 的离线套件。
// 夹具是**今天真实**的崩溃件（桌面端 1 份、临时实例 1 份、早于我动手的 1 份当负对照），
// 写在分支（真改 profile manifest）落在 os.tmpdir 的唯一临时目录里，不碰工作区也不碰 ~/.dsh。
// ⚠ 入库前的唯一改动：真实 Windows 用户名 `enmusubi4` 统一替换成 `sampleuser`（12 处，逐枚见 git 记录）。
//   栈、路径形状、退出码、时间戳全未动，所以判据仍跑在真实形状上——这条替换**不影响**任何一档归因结论。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseHostLog, attribute, classifyFrame, scanLogs, planMask, applyMask, restoreMask } from '../tools/fault-triage.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = (name) => path.join(here, 'fixtures', name)
let n = 0
const ok = (label) => console.log(`  ${String(++n).padStart(2, '0')} ok — ${label}`)

// 1. 桌面端形态：profiles/<p>/node_modules/<pkg>/
const deskTxt = fs.readFileSync(fx('crash-desktop-backroom.log'), 'utf8')
const deskParsed = parseHostLog(deskTxt)
const desk = attribute(deskParsed)
assert.ok(desk.culprit, '桌面端那份必须归因出嫌疑包')
assert.equal(desk.culprit.bundle, 'dsh-backroom')
assert.equal(desk.culprit.frame, 'buildProbe')
assert.ok(desk.official && desk.official.file.includes('/@deepseek-ai/dsh-hmr/'), '官面抛出点必须是 dsh-hmr')
// 成因行与包裹行分开：真实崩溃件的 errorHead 是 DEP0180 那行 DeprecationWarning（噪音），
// 能判案的是下一行的 `dsh: fatal load failure: TypeError [ERR_INVALID_ARG_TYPE]…`
assert.ok(/ERR_INVALID_ARG_TYPE/.test(deskParsed.fatalLine), `fatalLine=${deskParsed.fatalLine}`)
assert.equal(deskParsed.errCode, 'ERR_INVALID_ARG_TYPE')
assert.equal(deskParsed.exitCode, '1')
assert.ok(/DeprecationWarning/.test(deskParsed.errorHead) && !/ERR_INVALID/.test(deskParsed.errorHead),
	'errorHead 必须是那行包裹（噪音），不许与 fatalLine 混成一格')
ok('桌面端崩溃件归因＝dsh-backroom@buildProbe，官面抛出点＝dsh-hmr:462；成因行/包裹行分两格')

// 2. pnpm 形态：node_modules/.pnpm/<pkg>@file+.../node_modules/<pkg>/
const tempTxt = fs.readFileSync(fx('crash-tempinstance-pnpm.log'), 'utf8')
const temp = attribute(parseHostLog(tempTxt))
assert.equal(temp.culprit?.bundle, 'dsh-backroom', `实际=${JSON.stringify(temp.culprit)}`)
assert.equal(temp.culprit.via, 'installed-bundle')
assert.ok(tempTxt.includes('fatal load failure'))
ok('pnpm 形态（.pnpm/<pkg>@file+…）同样归因到包名')

// 3. 负对照：早于本窗动手的那份，帧全在官面/宿主 ⇒ 不许硬捏一个嫌疑包
const negParsed = parseHostLog(fs.readFileSync(fx('crash-no-culprit.log'), 'utf8'))
const neg = attribute(negParsed)
assert.equal(neg.culprit, null, `负对照被误归因为 ${JSON.stringify(neg.culprit)}`)
assert.ok(neg.frames.some((f) => f.kind === 'official'), '负对照确实有官面帧（说明不是解析失败）')
assert.equal(negParsed.fatalLine, null, '"只退了、没打 fatal 行"是真实存在的一档（10-01 两份），必须能吃')
assert.equal(negParsed.exitCode, '4294967295')
ok('负对照：无装侧帧 ⇒ culprit=null，不猜；且"无 fatal 行"那一档解析不报错')

// 4. junction/源码形态：靠 --source-root 认（这条正是本窗真实开发回路的形状）
const srcOnly = attribute({ frames: [{ fn: 'buildProbe', raw: 'file:///E:/dsh-plugins/dsh-backroom/lib/index.js', line: 290, col: 29 }] }, ['E:/dsh-plugins'])
assert.equal(srcOnly.culprit?.bundle, 'dsh-backroom')
assert.equal(srcOnly.culprit.via, 'source')
assert.equal(classifyFrame('node:internal/modules/esm/module_map:95:5').kind, 'internal')
assert.equal(classifyFrame('C:/x/resources/app.asar/dsh/node_modules/compression/index.js').kind, 'official')
ok('source-root 认包；node: 与 app.asar 树不被误判为装侧包')

// 5. scanLogs 目录形态＋时间倒序＋"不可归因"必须回原因而不是被悄悄丢掉
const rows = scanLogs({ logs: [path.join(here, 'fixtures')], sourceRoots: ['E:/dsh-plugins'] })
assert.ok(rows.length >= 4, `扫到 ${rows.length} 份`)
assert.ok(rows[0].time > rows[rows.length - 1].time, '应按时间倒序')
assert.ok(rows.every((r) => 'culprit' in r && Array.isArray(r.frames)))
const byName = Object.fromEntries(rows.map((r) => [path.basename(r.file), r]))
assert.equal(byName['crash-renderer.log'].culprit, null)
assert.match(byName['crash-renderer.log'].noCulpritReason, /renderer-crash/)
assert.equal(byName['crash-renderer.log'].rendererState, 'crashed')
assert.equal(byName['crash-no-culprit.log'].noCulpritReason, 'kill-shaped（exit=-1、无 `dsh: fatal` 行、子进程零输出 ⇒ **与 Stop-Process 强杀留下的件同形**，不可归因）')
assert.equal(byName['crash-no-culprit.log'].killShaped, true, 'exit=-1 且无成因行 ⇒ 必须标成"与强杀同形"，别让人以为抓到了崩溃')
assert.ok(!byName['crash-desktop-backroom.log'].killShaped, '有 fatal 行的那一枚不许被标成强杀形状')
assert.equal(byName['crash-desktop-backroom.log'].noCulpritReason, undefined, '能归因的那份不该带"不可归因原因"格')
assert.equal(byName['crash-tempinstance-pnpm.log'].timeFrom, 'mtime', 'CLI stdout 那份没有 time: 头，排序要退回 mtime 并标来源')
assert.equal(byName['crash-desktop-backroom.log'].timeFrom, 'header')
ok(`scan：目录输入 ${rows.length} 份，按时间倒序，逐份带 frames；不可归因的三份各回各原因`)

// 5b. 日志内容不可信：一枚裸 % 不能把归因工具自己打崩
const odd = attribute(parseHostLog('dsh: fatal load failure: Error x\n    at f (file:///C:/a%b/z.js:1:1)'))
assert.equal(odd.frames.length, 1, '坏转义的帧仍要收到表里')
assert.ok(['unknown', 'thirdparty', 'source'].includes(classifyFrame('file:///C:/a%b/z.js').kind))
ok('坏 URL 转义的帧路径不抛（decodeURIComponent 包在 try 里）')

// 6. 隔离的判定表（三条都必须拒绝）
const manifest = JSON.stringify({ name: 'p', dependencies: { 'dsh-backroom': 'file:E:/x' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-backroom'] } } }, null, 2)
assert.equal(planMask(manifest, 'dsh-backroom').ok, true)
assert.equal(planMask(manifest, '@deepseek-ai/dsh-base').reason, 'protected-bundle')
assert.equal(planMask(manifest, 'nope-not-here').reason, 'not-in-bundles')
const planned = planMask(manifest, 'dsh-backroom')
assert.deepEqual(planned.bundlesAfter.filter((b) => b === 'dsh-backroom'), [])
assert.equal(planned.dependencyKept, true, '§C8 屏蔽语义：只摘 bundles 行，dependency 必须留着')
ok('quarantine 判定：可摘／受保护／不在名册 三档各回各话')

// 7. 写分支：真落盘一次，验备份、验写后状态、验 restore 回到逐字节相同
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fault-triage-'))
try {
	const profileDir = path.join(tmp, 'profiles', 'desktop')
	fs.mkdirSync(profileDir, { recursive: true })
	const manifestPath = path.join(profileDir, 'package.json')
	const original = Buffer.from(manifest + '\n', 'utf8')
	fs.writeFileSync(manifestPath, original)
	const before = fs.readFileSync(manifestPath)

	const refused = applyMask({ profileDir, bundle: '@deepseek-ai/dsh-web-app', backupRoot: tmp })
	assert.equal(refused.ok, false)
	assert.ok(fs.readFileSync(manifestPath).equals(before), '被拒的那次必须一个字节都不动')

	const applied = applyMask({ profileDir, bundle: 'dsh-backroom', backupRoot: tmp })
	assert.equal(applied.ok, true, JSON.stringify(applied))
	assert.ok(fs.existsSync(applied.backup), '备份必须落在工作区与 ~/.dsh 之外')
	const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
	assert.equal(after.dsh.profile.bundles.includes('dsh-backroom'), false)
	assert.equal(after.dsh.profile.bundles.length, 2)
	assert.equal(after.dependencies['dsh-backroom'], 'file:E:/x', 'dependency 仍在（副本没删＝屏蔽不是卸载）')
	assert.ok(typeof applied.restoreCommand === 'string' && applied.restoreCommand.includes('restore'))

	const restored = restoreMask({ profileDir, from: applied.backup })
	assert.equal(restored.ok, true)
	assert.ok(fs.readFileSync(manifestPath).equals(original), 'restore 必须回到逐字节相同')
	ok('写分支：拒绝即零改动；摘除只动 bundles 行；restore 逐字节回原')
} finally {
	fs.rmSync(tmp, { recursive: true, force: true })
	assert.equal(fs.existsSync(tmp), false, '临时根必须清干净')
}

// ── 09. 命令行入口（#106 那一族的另一面：`npm run fault-triage` 指的正是这枚文件，
//      而它此前只 export、当脚本跑时**一个字都不打**还退 0 ⇒ 绿灯的假装置）───────────
{
	const tool = path.join(here, '..', 'tools', 'fault-triage.mjs')
	const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 30_000 })
	const none = run([])
	assert.equal(none.status, 2, `不带子命令要退 2（实退 ${none.status}）`)
	assert.ok(/用法/.test(none.stdout), `用法那一行必须在，实际头 80 字=${String(none.stdout).slice(0, 80)}`)
	const bad = run(['scan'])
	assert.equal(bad.status, 2, `scan 缺 --logs 要退 2（实退 ${bad.status}）`)
	assert.ok(/--logs/.test(bad.stdout), '缺参数时要给可抄的参数名')
	const scanned = run(['scan', '--logs', path.join(here, 'fixtures'), '--source-root', path.join(here, '..')])
	assert.equal(scanned.status, 0, `真扫一批夹具必须退 0（实退 ${scanned.status}）`)
	assert.ok(/dsh-backroom/.test(scanned.stdout), '夹具里那枚嫌疑包必须出现在表上')
	assert.ok(!/undefined/.test(scanned.stdout), '表上不许漏出 undefined（那一格是"没有值"的形状）')
	ok('命令行入口：不带子命令退 2 并打用法；真扫夹具退 0 且表上有嫌疑包（守卫让 import 时一个字都不多做）')
}

console.log(`\nPASS fault-triage 套件 — ${n} 步，0 失败（真实崩溃件＋tmp 写分支；不含对 ~/.dsh 的任何写入）`)
