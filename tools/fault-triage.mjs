#!/usr/bin/env node
/**
 * 崩溃归因与隔离（dsh-backroom 的正本；顶层 tools/dsh-fault-triage.mjs 只是一行转发壳）。
 *
 * 为什么是"崩溃后归因 + 下次启动前摘掉"，而不是"崩了继续跑"：
 * `dsh-app-boot/lib/index.js:3783-3818` 的 `installFailLoud()` 是故意的 fail-loud——漏网的
 * uncaughtException / unhandledRejection 一律写 stderr 再 `exit(1)`，只有**激活期**的 rejection
 * 被 `assembledActivationRejections` 豁免（那对应"没激活但不崩"）。所以同进程内阻止退出不做，
 * 做了等于拆宿主的设计，而且退出后模块/加载器状态本来就不确定。
 *
 * 两个动作：
 *   scan        读崩溃件（装机版 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`，
 *               或 CLI 实例自己的 stdout 日志），逐份报"哪一枚插件的哪一帧、以及官面哪一帧抛的"。
 *   quarantine  把某枚包从 profile 的 `dsh.profile.bundles` 里摘掉（§C8 的"屏蔽"语义：
 *               dependency 与安装副本都留着），默认 dry-run，`--apply` 才写；写之前逐字备份，可 restore。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const PROTECTED = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const MAX_FILE_BYTES = 256_000
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** file:// URL / Windows 反斜杠 / %20 统统摊平成可比较的小写正斜杠路径。 */
export function normalizeFramePath(raw) {
	let p = String(raw || '').trim()
	if (p.startsWith('file://')) p = p.slice('file://'.length)
	// 日志里的路径不可信：一枚裸 % 会让 decodeURIComponent 抛，归因工具不能因此自己崩
	try { p = decodeURIComponent(p) } catch {}
	p = p.replace(/\\/g, '/')
	if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
	return p
}

/**
 * 帧的归属分类。判"官面"要先于判"装侧包"：装机版运行时整体住在
 * `app.asar/dsh/node_modules/@deepseek-ai/`，那棵里出现 node_modules 不代表是我们的包。
 */
export function classifyFrame(raw, sourceRoots = []) {
	const p = normalizeFramePath(raw)
	if (p.startsWith('node:') || p.includes('node:internal')) return { kind: 'internal', path: p }
	if (p.includes('/@deepseek-ai/')) return { kind: 'official', path: p }
	if (p.includes('/resources/app.asar/') || p.includes('/app.asar/dsh/')) return { kind: 'official', path: p }
	const pnpm = p.match(/\/node_modules\/\.pnpm\/((?:@[^_/]+[+/])?[^_@]+)@/)
	if (pnpm) return { kind: 'installed-bundle', bundle: pnpm[1].replace('+', '/'), path: p }
	const flat = p.match(/profiles\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
	if (flat) return { kind: 'installed-bundle', bundle: flat[1], path: p }
	for (const root of sourceRoots) {
		const r = normalizeFramePath(root).replace(/\/+$/, '')
		if (r && (p === r || p.startsWith(r + '/'))) {
			const rest = p.slice(r.length + 1).split('/')
			return { kind: 'source', bundle: rest[0] || path.basename(r), path: p }
		}
	}
	if (p.includes('/node_modules/')) return { kind: 'thirdparty', path: p }
	return { kind: 'unknown', path: p }
}

/**
 * 一份崩溃件 → 元数据＋错误行＋帧表。
 * 两种真实形状都要吃（10-05 现读 8 枚 host + 2 枚 renderer 崩溃件）：
 *   装机版 host：`Error: dsh desktop host exited with <code>: <子进程 stdout 尾>`，
 *     真正的成因在**下一行**的 `dsh: fatal <阶段>: <Error> [CODE]: <message>`（也可能根本没有——
 *     10-01 那两份就是"只退了、没打 fatal 行"）；
 *   CLI 实例自己的 stdout：没有 `--- error ---` 包壳，直接就是 fatal 行＋栈。
 * 所以 errorHead（包裹行）与 fatalLine（成因行）分两格报，合成一格会随机指到噪音上。
 */
export function parseHostLog(text) {
	const header = {}
	for (const key of ['time', 'source', 'phase', 'app', 'platform', 'electron', 'node', 'locale', 'shell pid']) {
		const m = text.match(new RegExp('^' + key.replace(/ /g, '\\s') + ':\\s*(.+)$', 'm'))
		if (m) header[key] = m[1].trim()
	}
	const section = (text.split(/^---\s*error\s*---\r?$/im)[1] ?? text)
	const errorHead = (section.split(/\r?\n/).find((l) => l.trim() !== '') || '').trim()
	const fatalLine = (section.match(/^dsh: fatal [a-z ]+:.*$/m) || [])[0] || null
	const frames = []
	for (const m of section.matchAll(/^\s+at\s+(?:([^()]+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/gm)) {
		frames.push({ fn: m[1] || '(anonymous)', raw: m[2], line: Number(m[3]), col: Number(m[4]) })
	}
	return {
		header,
		source: header.source || null,
		label: (section.match(/dsh: (fatal [a-z ]+):/) || [])[1] || null,
		errorHead,
		fatalLine: fatalLine ? fatalLine.trim() : null,
		exitCode: (errorHead.match(/exited with (\d+)/) || [])[1] ?? null,
		rendererState: (errorHead.match(/^Error:\s*Desktop renderer exited:\s*(\S+)/) || [])[1] ?? null,
		errCode: fatalLine ? (fatalLine.match(/\[([A-Z0-9_]+)\]/) || [])[1] ?? null : null,
		frames,
	}
}

/** 归因：第一个落在"装侧包/源码树"上的帧＝嫌疑人；最上面的官面帧＝它误触的那枚方法。 */
export function attribute(parsed, sourceRoots = []) {
	let culprit = null
	let official = null
	const seen = []
	for (const f of parsed.frames) {
		const c = classifyFrame(f.raw, sourceRoots)
		seen.push({ fn: f.fn, kind: c.kind, bundle: c.bundle || null, file: c.path, line: f.line })
		if (!culprit && (c.kind === 'installed-bundle' || c.kind === 'source')) {
			culprit = { bundle: c.bundle, frame: f.fn, file: c.path, line: f.line, via: c.kind }
		}
		if (!official && c.kind === 'official') official = { frame: f.fn, file: c.path, line: f.line }
	}
	return { culprit, official, frames: seen }
}

export function scanLogs({ logs = [], sourceRoots = [], limit = 50, maxFiles = 200 } = {}) {
	const files = []
	for (const entry of logs) {
		if (fs.existsSync(entry) && fs.statSync(entry).isFile()) files.push(entry)
		else if (fs.existsSync(entry)) for (const f of fs.readdirSync(entry)) if (/\.log$/.test(f)) files.push(path.join(entry, f))
	}
	if (files.length > maxFiles) files.length = maxFiles
	const out = []
	for (const file of files) {
		let text
		let truncated = false
		try {
			const size = fs.statSync(file).size
			const fd = fs.openSync(file, 'r')
			try {
				const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES))
				fs.readSync(fd, buf, 0, buf.length, 0)
				text = buf.toString('utf8')
				truncated = size > MAX_FILE_BYTES
			} finally { fs.closeSync(fd) }
		} catch { continue }
		if (!/fatal|exited|did not activate|error/i.test(text)) continue
		const parsed = parseHostLog(text)
		const attr = attribute(parsed, sourceRoots)
		const row = {
			file,
			...parsed.header,
			label: parsed.label,
			errorHead: parsed.errorHead.slice(0, 200),
			fatalLine: parsed.fatalLine ? parsed.fatalLine.slice(0, 200) : null,
			exitCode: parsed.exitCode,
			rendererState: parsed.rendererState,
			errCode: parsed.errCode,
			frameCount: parsed.frames.length,
			truncated,
			...attr,
		}
		// CLI 实例 stdout 那份没有 `time:` 头 ⇒ 排序退回文件 mtime，并诚实标来源
		if (!row.time) {
			try { row.time = fs.statSync(file).mtime.toISOString(); row.timeFrom = 'mtime' } catch { row.timeFrom = 'unknown' }
		} else row.timeFrom = 'header'
		if (!attr.culprit) {
			row.noCulpritReason =
				parsed.source === 'renderer' ? 'renderer-crash（那份里没有插件帧）'
				: parsed.exitCode === '4294967295' && !parsed.fatalLine && parsed.frames.length <= 6
					? 'kill-shaped（exit=-1、无 `dsh: fatal` 行、子进程零输出 ⇒ **与 Stop-Process 强杀留下的件同形**，不可归因）'
				: parsed.frames.length === 0 ? 'no-stack（只有退出码，没有栈）'
				: 'no-installed-bundle-frame（栈全在官面/internal/第三方）'
			row.killShaped = String(row.noCulpritReason).startsWith('kill-shaped')
		}
		out.push(row)
	}
	out.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
	return out.slice(0, limit)
}

// ── 隔离：只动 dsh.profile.bundles 那一行（§C8），dependency 与安装副本留着 ──────
export function planMask(manifestText, bundle) {
	const before = JSON.parse(manifestText)
	const bundles = before?.dsh?.profile?.bundles ?? []
	if (!Array.isArray(bundles)) return { ok: false, reason: 'no-bundles-array' }
	if (bundles.includes(bundle) === false) return { ok: false, reason: 'not-in-bundles', bundles }
	if (PROTECTED.includes(bundle)) return { ok: false, reason: 'protected-bundle', bundles }
	const after = bundles.filter((b) => b !== bundle)
	const next = { ...before, dsh: { ...before.dsh, profile: { ...before.dsh.profile, bundles: after } } }
	return {
		ok: true, bundlesBefore: bundles, bundlesAfter: after,
		dependencyKept: Boolean(next.dependencies && bundle in next.dependencies),
		text: JSON.stringify(next, null, 2) + '\n',
	}
}

export function applyMask({ profileDir, bundle, backupRoot }) {
	const manifestPath = path.join(profileDir, 'package.json')
	const current = fs.readFileSync(manifestPath)
	const plan = planMask(current.toString('utf8'), bundle)
	if (!plan.ok) return { ok: false, reason: plan.reason, bundle }
	fs.mkdirSync(backupRoot, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const backup = path.join(backupRoot, `package.json.${stamp}.before`)
	fs.writeFileSync(backup, current)
	fs.writeFileSync(manifestPath, plan.text)
	const after = fs.readFileSync(manifestPath, 'utf8')
	const parsed = JSON.parse(after)
	const still = parsed?.dsh?.profile?.bundles?.includes(bundle) === true
	if (still) return { ok: false, reason: 'verify-failed-still-listed', bundle, backup }
	return {
		ok: true, bundle, manifestPath, backup,
		backupSha: sha(current), afterSha: sha(Buffer.from(after, 'utf8')),
		dependencyKept: plan.dependencyKept,
		restoreCommand: `node tools/dsh-fault-triage.mjs restore --profile-dir "${profileDir}" --from "${backup}"`,
		note: 'bundles 行已摘（§C8 屏蔽语义）。生效＝重启：10-05 临时实例两发实测——① 改文件后 hmr 的 package.json 监视 45 秒内没有触发任何 reload；② 官方 pluginManager.setBundleEnabled 回 application=failed（"profile reload requires the root Include entry"），盘上改了但纤维没卸。桌面端是不是"live profile"未测。',
	}
}

export function restoreMask({ profileDir, from }) {
	const manifestPath = path.join(profileDir, 'package.json')
	const src = fs.readFileSync(from)
	const cur = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : Buffer.alloc(0)
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	fs.writeFileSync(path.join(path.dirname(from), `package.json.${stamp}.pre-restore`), cur)
	fs.writeFileSync(manifestPath, src)
	const back = fs.readFileSync(manifestPath)
	return { ok: back.equals(src), manifestPath, sha: sha(src), bytes: src.length }
}

// ── CLI ────────────────────────────────────────────────────────────────────
function flag(argv, name) {
	const i = argv.indexOf('--' + name)
	if (i < 0) return null
	const v = argv[i + 1]
	return v === undefined || v.startsWith('--') ? true : v
}

export async function main(argv = []) {
	const cmd = argv[0]
	const json = flag(argv, 'json') === true
	const sourceRoots = argv.flatMap((a, i) => (argv[i - 1] === '--source-root' || argv[i - 1] === '-S') ? [a] : [])
	if (cmd === 'scan') {
		const logs = argv.filter((a, i) => (argv[i - 1] === '--logs' || argv[i - 1] === '-L') && !a.startsWith('--'))
		if (logs.length === 0) { console.log('scan 需要 --logs <日志文件或目录>（可给多次）'); return 2 }
		const rows = scanLogs({ logs, sourceRoots, limit: Number(flag(argv, 'limit')) || 50 })
		if (json === true) { console.log(JSON.stringify(rows, null, 2)); return 0 }
		if (rows.length === 0) { console.log('这批日志里没有可归因的崩溃件（不是"没崩"，是"这些文件里没有栈"）'); return 0 }
		console.log('时间(UTC)             阶段      嫌疑包(帧@行)                       官面抛出点                     成因行 / 不可归因原因')
		for (const r of rows) {
			const c = r.culprit ? c_pad(r.culprit) : '—'
			const why = r.culprit ? (r.fatalLine || r.errorHead) : `${r.noCulpritReason}（exit=${r.exitCode ?? '?'}${r.rendererState ? ' renderer=' + r.rendererState : ''}）`
			console.log(
				`${String(r.time || path.basename(r.file)).padEnd(21)} ${String(r.phase || '?').padEnd(7)} ${c.padEnd(32)} ` +
				`${String(r.official ? `${r.official.frame}@${path.basename(r.official.file)}:${r.official.line}` : '—').padEnd(28)} ${why.slice(0, 96)}`
			)
		}
		console.log(`\n共 ${rows.length} 份。要摘掉某枚：quarantine --bundle <名> --profile-dir <profile 目录> [--apply]`)
		return 0
	}
	if (cmd === 'quarantine') {
		let bundle = flag(argv, 'bundle')
		const profileDir = flag(argv, 'profile-dir')
		if (bundle === 'auto' || bundle === true) {
			// --bundle auto＝"从崩溃件里挑最近一枚有装侧帧的嫌疑包"，其余（备份/dry-run/受保护闸）一律照旧
			const logs = argv.filter((a, i) => (argv[i - 1] === '--logs' || argv[i - 1] === '-L') && !a.startsWith('--'))
			const rows = scanLogs({ logs, sourceRoots, limit: 200 }).filter((r) => r.culprit)
			if (rows.length === 0) { console.log('auto 挑不出嫌疑包：这批崩溃件里没有装侧帧（不是"没崩"）。请显式给 --bundle <名>'); return 4 }
			bundle = rows[0].culprit.bundle
			console.log(`auto 选中 ${bundle}（最近一份有装侧帧的崩溃件 ${path.basename(rows[0].file)}，${rows[0].time}，帧＝${rows[0].culprit.frame}@${path.basename(rows[0].culprit.file)}:${rows[0].culprit.line}）`)
		}
		if (typeof bundle !== 'string' || typeof profileDir !== 'string') { console.log('quarantine 需要 --bundle <名|auto> 与 --profile-dir <目录>（auto 时再给 --logs）'); return 2 }
		const backupRoot = typeof flag(argv, 'backup-root') === 'string' ? flag(argv, 'backup-root') : path.join(process.env.TEMP || '/tmp', 'dsh-fault-quarantine')
		const apply = flag(argv, 'apply') === true
		const manifestPath = path.join(profileDir, 'package.json')
		if (!fs.existsSync(manifestPath)) { console.log(`找不到 ${manifestPath}`); return 3 }
		const plan = planMask(fs.readFileSync(manifestPath, 'utf8'), bundle)
		if (!plan.ok) { console.log(`拒绝：${plan.reason}（bundle=${bundle}；受保护清单=${PROTECTED.join(', ')}）`); return 1 }
		if (!apply) {
			console.log(`dry-run：将从 bundles 摘掉 ${bundle}\n  之前 ${plan.bundlesBefore.length} 枚 → 之后 ${plan.bundlesAfter.length} 枚\n  dependency 保留=${plan.dependencyKept}（§C8 屏蔽语义；要复原用 restore）\n  加 --apply 才写盘。备份根：${backupRoot}`)
			return 0
		}
		const res = applyMask({ profileDir, bundle, backupRoot })
		console.log(JSON.stringify(res, null, 2))
		return res.ok ? 0 : 1
	}
	if (cmd === 'restore') {
		const profileDir = flag(argv, 'profile-dir')
		const from = flag(argv, 'from')
		if (typeof profileDir !== 'string' || typeof from !== 'string') { console.log('restore 需要 --profile-dir 与 --from'); return 2 }
		const res = restoreMask({ profileDir, from })
		console.log(JSON.stringify(res, null, 2))
		return res.ok ? 0 : 1
	}
	console.log('用法：dsh-fault-triage scan|quarantine|restore …\n  scan --logs <file|dir> [--source-root <dir>] [--json]\n  quarantine --bundle <名|auto> --profile-dir <目录> [--logs <dir>：auto 时用] [--apply] [--backup-root <目录>]\n  restore --profile-dir <目录> --from <备份文件>')
	return 2
}

function c_pad(c) { return `${c.bundle} ${c.frame}@${path.basename(c.file)}:${c.line}` }

// 直接命令行也要能用（`npm run fault-triage -- scan …` 此前是把这枚文件当脚本跑，而它只 export、什么都不执行）。
// 守卫按"是不是被当成入口"判：lib/index.js 与顶层转发壳 import 这枚文件时，一个字都不多做。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2))
}
