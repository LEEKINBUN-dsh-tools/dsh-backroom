#!/usr/bin/env node
// dsh-backroom/tools/web-debug.mjs — 在内置浏览器里调试 dsh 的那条路（10-30 实测）
//
// 为什么需要这一枚：composer 是 Lexical，`execCommand` 对它无效；而 CLI `web` 实例没有 Chromium，
// 所以"用外部浏览器调试"只有一条路——页内 JS 往 composer 里发一发 `beforeinput`。这条路的三个前置
// （清两层首启模态／先选工作区／模型 provider 要跟桌面同形）以前只能靠人记，本工具把它们收进一个命令。
//
// 红线：本工具**只碰自己 --home 指定、且在用户 ~/.dsh 之外**的临时根；不读用户 home（密钥通过
// `--key-env` 从**调用方已经导好的环境变量**取，工具本身不碰 ~/.dsh）；`stop` 只按它自己写的
// pid 文件停它自己开的那一枚。
//
// 用法：
//   node tools/web-debug.mjs start --home D:/Temp/dsh-web-debug/home --workspace D:/Temp/dsh-web-debug/ws \
//        --key-env SENSANOVA_TOKEN_PLAN_API_KEY [--port 3981] [--preset-file <cordis.patch.yml>]
//   node tools/web-debug.mjs snippet [--workspace <dir>]     # 只打印注入片段（带工作区时先建）
//   node tools/web-debug.mjs stop --home <同上>
//   node tools/web-debug.mjs status --home <同上>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return dflt
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? dflt : v
}

const die = (msg, code = 2) => { console.log(msg); process.exit(code) }

const exePath = () => {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  if (fs.existsSync(local)) return local
  const all = 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe'
  if (fs.existsSync(all)) return all
  return ''
}

// 只允许仓外临时根：任何落在用户 ~/.dsh 里的 --home 一律拒（红线）
const guardHome = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') die('需要 --home <临时根>')
  const home = path.resolve(raw)
  const dshHome = path.resolve(path.join(os.homedir(), '.dsh'))
  const rel = path.relative(dshHome, home)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) die(`拒绝：--home 落在 ${dshHome} 里（本工具只碰仓外临时根）`)
  return home
}

const SNIPPET = (workspace) => `// 在目标页面的 JS 执行环境里跑（Qoder 内置浏览器：evaluate_script）
// 0) 清掉两层首启模态；1) 只发一发 beforeinput（再发 input 会翻倍）；2) 点发送按钮
for (let i = 0; i < 3; i += 1) {
  const b = [...document.querySelectorAll('[role=dialog] button')].find(x => x.innerText.trim() === '继续' || (x.getAttribute('aria-label') || '') === '关闭');
  if (!b) break;
  b.click();
  await new Promise(r => setTimeout(r, 300));
}
const ed = document.querySelector('[contenteditable][data-lexical-editor]');
if (!ed || ed.getAttribute('contenteditable') !== 'true') throw new Error('composer 未启用：先在页面上选工作区${workspace ? `（${workspace}）` : ''}');
ed.focus();
const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false);
const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '只回一个字：好', bubbles: true, cancelable: true, composed: true }));
await new Promise(r => setTimeout(r, 200));
const send = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '发送消息');
if (!send || send.disabled) throw new Error('发送按钮不可用：检查注入是否生效');
send.click();`

const readState = (home) => {
  const f = path.join(home, 'web-debug.json')
  if (!fs.existsSync(f)) return null
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}

const portBusy = (port) => new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(true))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, '127.0.0.1')
  })
})

const waitForUrl = (child, timeoutMs = 90_000) => new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error(`启动超时：${timeoutMs}ms 内没看到 "dsh web: http://…"`)), timeoutMs)
  const onData = (chunk) => {
    buf += String(chunk)
    const m = buf.match(/dsh web: (http:\/\/\S+)/)
    if (m) { clearTimeout(timer); resolve({ url: m[1], log: buf }) }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`子进程退出 code=${code}\n${buf.slice(-600)}`)) })
})

// token URL 换 cookie（同源）：GET 带 ?token= 会 set-cookie；不把 token 写进任何文件
const exchangeToken = async (url) => {
  const res = await fetch(url, { redirect: 'manual' })
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  const jar = cookies.filter(Boolean).map((c) => c.split(';')[0]).join('; ')
  if (jar === '') throw new Error(`换 cookie 失败：HTTP ${res.status}，没有 set-cookie`)
  return jar
}

const createWorkspace = async (origin, cookie, dir) => {
  const body = { type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create', payload: { args: { request: { path: dir } } } }
  const res = await fetch(`${origin}/api/workspace/create`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留原文 */ }
  const value = json && json.result && json.result.value
  if (!value || !value.workspace) throw new Error(`workspace/create 失败：HTTP ${res.status} ${text.slice(0, 240)}`)
  return { workspaceId: value.workspace.workspaceId, path: value.workspace.path, created: value.created }
}

const startCmd = async () => {
  const home = guardHome(flag('home'))
  const port = Number(flag('port', '3981'))
  const wsDir = flag('workspace', '')
  const keyEnv = flag('key-env', '')
  const presetFile = flag('preset-file', '')
  const exe = exePath()
  if (exe === '') die('找不到 DeepSeek Harness.exe（试 --exe 也不支持；请装官方桌面端）')
  const asar = path.join(path.dirname(exe), 'resources', 'app.asar')
  const cliJs = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  // 本工具跑在**普通 node** 里，stat 看不进 app.asar（那是 Electron 的 fs 补丁才有的能力）⇒
  // 只验 asar 本体在场；cli.js 的路径交给 exe 自己解析（10-30 实测能起）。
  if (!fs.existsSync(asar)) die(`找不到 app.asar：${asar}`)
  const state = readState(home)
  if (state && state.pid) die(`这个 home 已经有一枚在跑（pid=${state.pid} port=${state.port}）；先 stop`)
  if (await portBusy(port)) die(`端口 ${port} 已被占用；换 --port`)
  if (keyEnv !== '' && (process.env[keyEnv] === undefined || process.env[keyEnv] === '')) die(`环境变量 ${keyEnv} 没有值（本工具不从 ~/.dsh 读密钥）`)

  const profileDir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  if (presetFile !== '') {
    if (!fs.existsSync(presetFile)) die(`--preset-file 不存在：${presetFile}`)
    fs.copyFileSync(presetFile, path.join(profileDir, 'cordis.patch.yml'))
    console.log(`preset: copied ${presetFile} -> ${path.join(profileDir, 'cordis.patch.yml')}`)
  }
  const env = {
    ...process.env,
    DSH_HOME: home,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: exe,
  }
  // 只把调用方已经导好的那枚 provider key 透传给孩子；不打印值
  if (keyEnv !== '') env[keyEnv] = process.env[keyEnv]

  const child = spawn(exe, ['--expose-internals', cliJs, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true })
  child.unref()
  let url = ''
  try { ({ url } = await waitForUrl(child)) } catch (error) {
    try { process.kill(child.pid) } catch { /* 已退 */ }
    die(`启动失败：${String(error).slice(0, 600)}`, 3)
  }
  const origin = new URL(url).origin
  const cookie = await exchangeToken(url)
  let ws = null
  if (wsDir !== '') {
    fs.mkdirSync(wsDir, { recursive: true })
    ws = await createWorkspace(origin, cookie, wsDir)
  }
  const stateOut = { pid: child.pid, port, origin, url, home, workspaceId: ws ? ws.workspaceId : null, workspacePath: ws ? ws.path : null, startedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(home, 'web-debug.json'), JSON.stringify(stateOut, null, 2))
  console.log(`url: ${url}`)
  console.log(`pid: ${child.pid}  home: ${home}`)
  if (ws) console.log(`workspace: ${ws.workspaceId}  path: ${ws.path}  (${ws.created ? 'created' : 'already existed'})`)
  console.log('\n下一步：在内置浏览器里打开上面那枚 url，选好工作区，然后跑 `node tools/web-debug.mjs snippet`')
  // 子进程的 stdout/stderr 管道会拽住父进程的事件循环（即使 unref）⇒ 读到这里就断开并退出，
  // 否则调用方会看到一个"启动成功但命令不返回"的假挂起（10-30 实测：state 文件已写好、进程还吊着）。
  try { child.stdout.destroy(); child.stderr.destroy() } catch { /* 已关 */ }
  process.exit(0)
}

const snippetCmd = () => {
  console.log(SNIPPET(flag('workspace', '')))
}

const stopCmd = async () => {
  const home = guardHome(flag('home'))
  const state = readState(home)
  if (!state || !state.pid) die('这个 home 没有记录在跑的实例')
  try { process.kill(state.pid) } catch (error) { console.log(`pid ${state.pid} 已不在：${String(error).slice(0, 80)}`) }
  fs.writeFileSync(path.join(home, 'web-debug.json'), JSON.stringify({ ...state, pid: null, stoppedAt: new Date().toISOString() }, null, 2))
  console.log(`stopped pid=${state.pid} port=${state.port}`)
}

const statusCmd = async () => {
  const home = guardHome(flag('home'))
  const state = readState(home)
  if (!state) die('没有状态文件（还没 start 过）')
  const busy = await portBusy(state.port)
  console.log(JSON.stringify({ ...state, portListening: busy }, null, 2))
}

if (cmd === 'start') await startCmd()
else if (cmd === 'snippet') snippetCmd()
else if (cmd === 'stop') await stopCmd()
else if (cmd === 'status') await statusCmd()
else die('用法：start | snippet | stop | status（见文件头注释）', 2)
