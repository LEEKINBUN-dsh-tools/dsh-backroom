# dsh-backroom（后台间）

给 DeepSeek Harness（`dsh`）**插件作者**用的一间只读后台：把宿主自己那本没人读的日志缓冲，用循环口 HTTP 端点摊开；并且在**正在跑的那枚进程里**现场回答一件事——插件到底够得到官面哪些服务面。

本插件是社区件，不是 DeepSeek AI 官方产品。

## 为什么需要它

装机桌面端（0.2.0-rc.2 起；现版 **0.2.1-rc.2**）上缺的两样东西，都不是"官方没开放接口"：

- **宿主日志没人读。** `ctx.logger` 自带的唯一出口是 cordis 那本 1000 条内存环形缓冲（`logger.buffer`），而发行物里只有"启动致命失败"那一条路注册过第二枚 sink。宿主代码走 logger 不走 console（光 `dsh-hmr` 就打 19 发 logger），装机版后端子进程的 stdout 又被 pipe 进 GUI 进程丢掉 ⇒ 于是"插件装了但没动静"这种现场**一条凭据都没有**。
- **可达性当年只量过一次、且记错了。** `ctx.get('sessionController')` 在插件纤维里到底能不能取到，是由**正在跑的进程**决定的，不是 `.d.ts` 决定的。本插件用一枚活体矩阵回答它，而不是拿猜测当结论。

## 它做什么

当前这一版是**探针档＋失败归因档＋会话窄口＋建会话档**：只有宿主半、**六枚端点**（四枚只读：`probe`／`logs`／`faults`／`presets`；两枚动手：`sessions` 建与收回、`session` 发一发——都要 env key），没有 UI，插件自身不写盘。

| 端点 | 回什么 |
|---|---|
| `GET /dsh-backroom/probe` | 逐枚服务面矩阵：每个名字把 `ctx.get(name, true)` 与 `ctx.get(name, false)` **分开**报成 `present(<类型>)` / `absent` / `threw: <原文>`，并列出该面自己的方法名；声明过与未声明依赖的属性访问结果各记一发；`hmr.getLinked()` 原样带出；**本插件 apply 之前缓冲里已有几条**（这一发就是"能不能回放"的判决）；node 版本、argv、`DSH_*` 变量**名**（不给值）、`ctx.fiber.state`。 |
| `GET /dsh-backroom/logs?limit=&level=&contains=` | 日志尾：自 apply 起 `ctx.logger` 打的**全部**，外加插件们的 `console.error/warn`。`level` 收 `error\|info\|warn\|debug` 也收官面数值档 0..3。环形上限 4000 条，并如实报丢了几条。 |
| `GET /dsh-backroom/faults?limit=&dir=` | **崩溃归因**：读桌面端那两类崩溃件（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`／`-renderer.log`），逐份回"哪一枚**装侧包**的哪一帧（嫌疑）＋官面哪一帧抛的（它误触的那枚方法）＋成因行 `dsh: fatal …: TypeError [ERR_INVALID_ARG_TYPE] …` 与包裹行分开"；归不出嫌疑包的那份**各回各原因**（`renderer-crash`／`no-stack`／`kill-shaped`／`no-installed-bundle-frame`），不硬捏。**`kill-shaped` 这一档是 10-19 新加的**：`exit=-1`＋没有 `dsh: fatal` 行＋栈 ≤6 帧＝"后端子进程被从外面带走"那一形，与 `Stop-Process` 强杀留下的件**同形** ⇒ 归因装置**拒绝**把它算成任何插件的缺陷（`row.killShaped=true`）。10-19 那批"写面一开就挂"的说法就是被这一档否掉的：4 枚 host 件全 716 B 同字节，其中两枚的時刻与统筹自己的两次重启对得上。默认根＝桌面端那一棵；CLI 临时实例用 `DSH_BACKROOM_CRASH_LOGS=<目录>` 指开。`dir` 只准落在白名单根内（这枚端点免鉴权，不能当本机任意文件的读 oracle），越界回 **403**。 |
| `GET`/`POST /dsh-backroom/session?session=&key=` | **会话窄口（默认全关）**：GET 读一枚登记会话的回合面——读的是官面投影袋里**确实在册**的两枚（`turnOutline` 回合数组、`sessionStats.turns`），回包给 `turnCount/lastTurn/lastResponseChars/asOfSeq/readable`；POST 往那枚**已登记的**会话发一条 prompt，`&wait=turn-end&timeoutMs=…` 等到"多出一回合且那一回合的 `response` 被 `turn/end` 填上"，回 `ended/endedClaim/turnStarted/assistantResponded/waitedMs`。只走官面 handler（`sessionController.prompt/projections`，**两枚参数 `request, signal`**）。10-09 桌面端端到端：一发 prompt 前后 `turnCount 1→2`、`asOfSeq 19→30`，日志里对应两条 `turn/end reason:"completed"`、回复两条。读不到判据时端点自报 `endedClaim:"unreadable"`，不把手上没证据写成"没结束"。⚠ 旧写法"读 `turnBoundary.lastTurn`"是猜的、实测**不在公共袋里**，已改判（正文＝`docs/PLUGIN-RULES.md` §H.5） |
| `GET /dsh-backroom/presets` | **只读，不要 key**：现读官面 `agentPresets.list()` 的名册（`{id,name?,description?,order?,broken?}`，激活失败那枚连原因一起回）＋`defaultId`，外加 `permissionPresets.catalog()`（`names`／`options`／`defaultPreset`）与**当前五把闸的状态**；如果官面默认权限档就是最宽那一枚，这里会直接给一句 `permissionWarning`。10-19 真宿主现读名册 **8 枚**＝`standard`(默认)／`ptc`／`minimal`／`cordis`＋四枚 `wsl-*` ⇒ **档位名一律运行时读，不写死**（名册随订阅开关变）。 |
| `GET`/`POST /dsh-backroom/sessions?key=` | **建会话档（10-19 用户改判「不需要切换模型，其他做完」）**：POST `{cwd | workspaceId, agentPreset?, caller?}` 走官面 `sessionController.create(request)` 建一枚新会话（**模式在创建时一次带上**——官面 `agentPresets.select` 的 jsDoc 逐字写着只能"在第一回合之前"，所以已有会话改不了档）；POST `{op:'archive'\|'unarchive', sessionId}` 只能收**本插件自己建的**那几枚（走官面 `workspaceController.archiveSession`）。GET 回这枚进程的建设账（`owned`／`spendTokens`／名额／预算）。真宿主两发实测：建 `minimal` 与 `ptc` 各一枚、标题打成 `backroom:<caller>`、往新建会话里发一问 `ended:true`（`turn 0→1`、3.4 s、账本现刷 **18,100** token）、归档回 `archivedNow:true`＋`archivedSetSize:13`；越界 cwd ⇒ **403 `cwd-outside-roots`**、拿用户自己的会话去归档 ⇒ **403 `not-owned`**。 |

### 给其他 agent 的一页用法（怎么发现它／调用格式／env／局限）

**它怎么被发现**（按可靠度排）：① dsh 会话里的模型每轮都看得见工具名 ⇒ 工具面里有 **`backroom_entry`**（只读，回 `baseUrl`＋六枚端点调用格式＋每把闸＋硬局限）；② 任何本机进程都能 `GET /dsh-backroom/presets`（**不要 key**）；③ 本 README 的端点表。

**认 baseUrl**（0.2.1-rc.2 起端口随机）：在 `DeepSeek Harness.exe` 那一族 PID 的监听口里，找 `GET /dsh-backroom/probe` 回 **200** 的那一枚；或直接跑启动器，它会打印 `backend port = …`。**别猜 0.2.0 那个写死的端口**——新版那一口永远没人听（`PITFALLS.md #107`）。

**最小调用序列**（`$P`＝后端端口，`$K`＝启动器打印的那把 key）：

```bash
# 0) 名册（免 key）：这台机器此刻有哪些模式（standard 默认 / ptc / minimal / cordis + 四枚 wsl-*）
curl -s "http://127.0.0.1:$P/dsh-backroom/presets"

# 1) 建一枚会话（要 key；cwd 必须落在 DSH_BACKROOM_WORKSPACE_ROOTS 内）
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/sessions?key=$K" -H 'content-type: application/json' \
  -d '{"cwd":"D:/Temp/backroom-ws","agentPreset":"minimal","caller":"some-agent"}'
# → {"sessionId":"session-…","agentPreset":"minimal","titleState":{...},"quota":{...},"permissionPreset":"…"}

# 2) 往里发一条（本插件建的会话**不需要**再改 DSH_BACKROOM_SESSION_ALLOW）
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/session?key=$K&session=<sid>&wait=turn-end&timeoutMs=90000" \
  -H 'content-type: application/json' -d '{"text":"只回一个字：好"}'
# → {"accepted":true,"ended":true,"turnStarted":true,…,"before":{…},"after":{…}}

# 3) 看账（本进程建了什么、花了多少、还能建几枚）
curl -s "http://127.0.0.1:$P/dsh-backroom/sessions?key=$K"

# 4) 收回去（只准收自己造的；归档＝隐藏不是删除）
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/sessions?key=$K" -H 'content-type: application/json' \
  -d '{"op":"archive","sessionId":"<sid>"}'
```

**env 一览**：见下面「配置」那节（每把闸的含义与"不设＝什么"都写着）。

**key 怎么带（10-19 尾部按实物反馈补的一格）**：三选一——`?key=<k>`、请求头 `x-backroom-key: <k>`、或 `Authorization: Bearer <k>`；**只用请求头是最推荐的写法**（查询串会进各种日志）。别的 agent 不必知道 key 的值：启动器默认把它写在一个**可读的文件**里（默认 `%TEMP%\dsh-backroom-key.txt`，可用 `-KeyFile` 改；`-Ephemeral` 才是"一次性、不落盘"的老行为），并把这个路径设进 `DSH_BACKROOM_KEY_FILE`；读不到文件时，`no-key` 的报错正文里会直接给出这个路径。⚠ 老实说：**本机任意进程都读得到那个文件** ⇒ 它挡的是"手滑/没带凭据"，不是恶意本机进程；真正的边界仍是 allowlist／roots／名额／预算／owned 那五把闸。

**局限（写给下一位 agent，别拿它当万能的）**：

- `session`／`sessions` **不是模型工具** ⇒ dsh 里的模型不能自己建会话/发消息；得由外部进程（你的 agent、CI、脚本）带 key 调 HTTP。
- **不能切模型**、**不能改权限档**（插件结构上就没有 `permissionPresets.set`）、**不能删会话**（官面只有归档＝隐藏，盘上残留未量化）。
- 预算／名额／账本都是**按进程**的：重启后 owned 清空、名额复位；它不是审计账本，"昨天谁建过"查不到。
- 发消息有界：6 发/分钟、text ≤4000 字符、等待 2–120 s；建会话 3 枚/小时；预算默认 60,000 token（≈4 回合，标度见上）。
- 归档之后再往里发 ⇒ 403（owned 出局）；拿**别人的**会话去归档 ⇒ 403 `not-owned`；档位读不到时只报不拦（`permissionGate:"unknown-preset"`）。



### 约束为什么换轴（这一段是回答"你的安全约束是不是伪命题"）

**用户 10-19 的原话**：「你发给 dsh，让它花钱，和 dsh 自己花的钱，不是一样的吗？绝不给任意会话一个替你花钱的按钮是安全还是偷懒？」——**这句在"钱"这一维上是对的**，旧那句红线把风险说成了支出，而支出没有不对称（账单同一个口袋）。所以那句"绝不新建会话"**有一半是伪命题**，另一半（也是真的那一半）是另外三样：**这枚会话挂哪棵目录／生效哪一枚权限档／造出来能不能收回去**。约束因此**换轴而不取消**，五把闸每把都长在官面实物上、且都是**导出的纯函数**（夹具直验，不等真宿主）：

| 闸 | 实物在哪 | 默认值与它的标度 |
|---|---|---|
| 范围 | `DSH_BACKROOM_WORKSPACE_ROOTS`（与建工作区共用同一把 `rootGate`） | **没设＝建会话整格 `disabled`**；`cwd` 必须落在名单根内，越界 403 |
| 名册 | `presetGate(agentPresets.list(), 想要的 id, DSH_BACKROOM_ALLOW_PRESETS)` | 想要的档位必须**当场**在名册里、且不带 `broken`；读不到名册 ⇒ 502 `roster-unavailable`（**绝不猜一个 id 送进你的会话**） |
| 名额 | `hourWindow(limit)`，`DSH_BACKROOM_MAX_SESSIONS_PER_HOUR` | 默认 **3/小时**（每建一枚都在你 profile 里长一份资产，而"归档"只是隐藏）；后面的闸挂了会**把名额退回**（`undo`），一次越界不许白吃一小时 |
| 预算 | `budgetGate(累计 tokenUsage, DSH_BACKROOM_TOKEN_BUDGET)` | 默认 **60,000**——标度来源＝靶会话 durable 日志逐回合实测 **13,762／13,847／14,794／17,276（均值 14,920）** ≈ 4 回合；只作用于**本插件建的**会话（你手工开的会话花费本来就在流里，插件不是它的账房） |
| 档位 | `denyGate(permissions 投影 currentValue, DSH_BACKROOM_DENY_PRESETS)` | **默认名单为空＝只回显不拦**：本机 `catalog().defaultPreset` 实测就是 `danger-full-access`，拦它等于新建会话全废（那是把"默认关"换个地方）；要拦请点名 |

"不许放宽权限档"这一条**不靠拦默认值**，改成**结构上做不到**：全仓没有 `permissionPresets.set` 那一发调用，第 17 步哨兵按面白名单（`pp` 面只许 `catalog`、`agentPresets` 面只许 `list`），并有合成负对照（把 `pp.set(` 塞回去必须红）。同样**没做**的两格：切模型（`session/selectModel`，会改变后续每一发计费）与把 `session`／`sessions` 做成模型工具（不给任意会话一个能建会话的按钮）。
归档那一格要说实话：官面原句是 *“Hide one known Session from Workspace grouping surfaces”* ⇒ **是隐藏不是删除**，盘上残留本窗未量化（挂在版本账本 `PQ-05`）；且它回的是**整个归档集**（本机 13 枚）所以回包自己算出 `archivedNow`，别把集合大小读成"我归档了 13 枚"（`PITFALLS.md #108`）。


### 先说清"窄口"是什么（这是一句行话，换成白话）

**"窄口"＝一扇默认锁着的门，只在满足三个条件时才打开一条很细的缝。**

这个插件本来只有只读端点（看一眼日志、看一眼崩溃件、看一眼名册，什么都不改）。动手的那两枚不一样：`session` 能**往你指定的会话里发一条消息**（会花你的额度），`sessions` 能**新建一枚会话**（会往你 profile 里长一份资产）。所以它们不是"开着但劝你别乱用"，而是**默认根本不响应**：

1. 启动 dsh 时没设 `DSH_BACKROOM_SESSION_KEY` ⇒ 两枚动手端点问什么都是 `403 disabled`，等于不存在；
2. 设了 key，但你要发消息的那枚会话**既不在 `DSH_BACKROOM_SESSION_ALLOW` 名单里、也不是本插件刚建的** ⇒ `403 not-allowlisted`／`no-allowlist`（它绝不"帮你挑最近一枚会话"）；建会话还要另过上面那五把闸；
3. 两道都过了，还有限速（每分钟 6 发）、限长（4000 字／16 KB）、限时（等待最多 120 秒），以及名额／预算／档位三把新闸。

"窄"体现在：**只能对指定会话发文本，只能读它跑完没有**——不能建会话、不能切模型、不能取消、不能改队列、不碰 token。要更宽的能力得改代码，改代码就会被那套哨兵挡住（第 17 步会把"env 名字少一枚""多一个调用点""出现 create"直接判红）。

**日常怎么用（安全优先，也省事）**

- 平时：照常点图标启动 dsh。门是关的，四枚只读端点照用。
- 要动手那一发时（发消息或建会话）：跑一次启动器，它现铸一枚一次性 key、认出后端端口、把要粘的 curl 全打印出来（不落盘、不进注册表、退出就没了）。

```powershell
# 只开"发消息"那一格：
powershell -File E:\dsh-plugins\dsh-backroom\tools\start-desktop-with-mouth.ps1 -Sid <你的会话id>
# 顺便开"建会话"那一格（不给 -Roots 时，POST /sessions 一直是 disabled）：
powershell -File E:\dsh-plugins\dsh-backroom\tools\start-desktop-with-mouth.ps1 -Sid <你的会话id> -Roots "D:/Temp/backroom-ws" -MaxSessions 3 -Budget 60000
# → use this key for this run: 546bb02911b9…（每次都不一样）
# → gates: roots=D:/Temp/backroom-ws presets=(unset: roster decides) maxSessions=(default 3/h) budget=(default 60000 tokens)
# → backend port found after 3s / backend port = 9960（**每次启动都可能不同**，见下面那格）
# → probe:/mouth:/roster:/create:/ledger: 五行 curl 直接粘（roster 那行不要 key）
```

**后端端口这一格（10-19 改判，重要）**：桌面端 **0.2.0-rc.2 写死 `19387`；0.2.1-rc.2 起改成 `--port 0`（系统分配）⇒ 每次启动随机**（本机本窗实测七枚：`12469`／`12750`／`2495`／`4606`／`9381`／`9732`／`9960`）。所以**别再用"19387 有没有监听"判死活**——那一格在新版上**永远回"没监听"**，看着像"插件把宿主弄挂了"，其实是尺瞎了（本窗就差点这么误判一次，凭据＝`docs/compat/VERSIONS/0.2.1-rc.2/` P22）。现行认法两条：
- **有本插件**：`GET /dsh-backroom/probe` 免 cookie 回 **200** 的那一枚就是后端（启动器用的正是这条）。
- **没有本插件**：在 `DeepSeek Harness.exe` 那一族 PID 的监听口里，找根路径回 **401 ＋ `dsh web authentication required; reopen the URL printed by dsh web.`** 的那一枚。⚠ 新版同族还另有 **`9230`＝官面 inspector 的 CDP 口**（`/json/version` 自报 `Browser:"dsh-experimental-inspector/0"`），它回 **404**，别认成后端、更别认成"宿主死了"。

- 不常驻的理由：常驻要把 key 写进用户环境变量，那份明文对本机任意进程、漫游备份都可见。不常驻买到的是**默认关闭**＋**key 不落盘**，不是绝对安全（能读你环境变量的进程本来也读得到你的 cookie）——所以它是"更小的暴露面"。
- `-Sid` 建议填一枚**专门当靶子的空会话**，用完从名单里摘掉就是关门。

### 会话里的模型怎么用（Agent 工具面）

三枚只读端点虽然免 cookie，但**会话里的模型不知道这个端口存在**——没有工具面就"只有被提示过的那一发能用"。所以本插件把它们注册成官方 `defineTool` 工具（`ctx.get('tools', false)` 松散取，取不到就如实报 `absent`，绝不因工具面缺席而整包不挂）：

| 工具名 | 干什么 | 要不要开关 |
|---|---|---|
| `backroom_probe` | 宿主形状：可达矩阵、本插件各项计数（含会话入口的拒绝账） | 不要，只读 |
| **`backroom_entry`** | **入口卡**：后端口怎么认、六枚端点调用格式、每把 env 闸、以及硬局限（不切模型／不是工具／归档只是隐藏）。**别的 agent 要靠这一枚发现这个入口**——工具名是模型每轮真正看得见的东西 | 不要，只读 |
| `backroom_logs` | 宿主日志尾（`limit/level/contains`） | 不要，只读 |
| `backroom_faults` | 崩溃件归因（`limit/dir`） | 不要，只读 |
| `backroom_workspace` | `list` 列工作区／`create` 建一枚（官面 `workspaceController.create`，已存在回 `created:false`） | **要**：`DSH_BACKROOM_WORKSPACE_ROOTS`（逗号/分号前缀名单）；没设＝`disabled` |
| `backroom_wsl_workspace` | `distros/ls/check` 走 `dsh-wsl-workspace` 自己的 loopback 桥；`create` 按它客户端那条顺序拼（官面 create ＋ 它的 `registerWindows`／`setUser`） | `create` 要：`DSH_BACKROOM_WSL_DISTROS`；只读三档不要。**桥打去哪一枚端口**（10-19 改）＝`DSH_BACKROOM_BRIDGE_BASE` 显式给 > 自家路由被访问时 Host 头里那枚**环回** origin > 两样都没有就**一个字都不发**并回 `bridge-base-unknown`（旧写法回落到写死的 19387，新版那口上根本没东西 ⇒ 假"桥坏了"；`GET /dsh-backroom/probe` 的 `bridge` 格就是"为什么没发"的读数处） |
| — | **`session` 与 `sessions` 两枚都不做成工具** | 安全优先，而且这次给的是理由不是口号：一枚能自己建会话的会话，等于能在没有"点名的人"背后长资产、花额度；而名额／预算两把闸是**按进程**算的，从跑着的 agent 内部去满足它们太容易 ⇒ 建会话与发消息这两次"动手"都留在 HTTP 这一侧，由人启动那一发决定 |

两格实现取向值得说明：① **WSL 那档不复制别人的私有状态**——`~/.dsh/wsl-workspaces.json` 归 `dsh-wsl-workspace` 写，我只按它自己客户端的调用顺序委托；官面 create 失败时**不会**去动登记（不留半截），登记失败时回包点明"工作区建好了但 bash 可能不进 WSL，按 `register.error` 修"。② 路径映射（`/mnt/e/tmp`→`E:\tmp`，其余→`\\wsl.localhost\<distro>\…`）与两把白名单判定都是**文件头导出的纯函数**，夹具直接验，包括"`E:/ab` 不算 `E:/a` 之内"这一格。

**工具面已证的两档**（10-09 真桌面端）：`GET /dsh-backroom/probe` 回 `toolsState.status="registered(5)"`、`lastError:""`；独立介质——会话日志最新一发 `request/header.tools` 里五枚全在，而重启前那两发 0 命中。也就是**"注册上了"与"模型看得见"分别量过**，没拿前者冒充后者。



```bash
# 启动 dsh 之前设（不设＝这枚端点等于不存在）
DSH_BACKROOM_SESSION_KEY=一把本地密钥
DSH_BACKROOM_SESSION_ALLOW=<sessionId1,sessionId2>
# $P＝后端端口，按上面那格认出来（0.2.1-rc.2 起每次启动随机；启动器会把它打印出来）
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/session?key=…&session=<登记的 sid>&wait=turn-end&timeoutMs=60000" \
     -H 'content-type: application/json' -d '{"text":"只回一个字：好"}'
```

| 闸 | 行为 |
|---|---|
| 1 | `DSH_BACKROOM_SESSION_KEY` 未设 ⇒ `403 disabled`（一枚都不放行，也不报错——等于不存在） |
| 2 | `?key=` 与 env 逐字**等时**比较（`crypto.timingSafeEqual`），不符 ⇒ `403 bad-key` |
| 3 | `sessionId` 必须在 `DSH_BACKROOM_SESSION_ALLOW` 名单里，**或**是本插件刚经 `/sessions` 建出来的那一枚（owned）⇒ 否则 `403 not-allowlisted`／`no-allowlist`；也绝不"挑最近一枚"。**own 边界的两头都验过**：归档掉自己建的之后它就出局（再发 ⇒ 403），拿用户自己的会话去 archive ⇒ 403 `not-owned` |
| 4 | 速率：每分钟默认 **6** 发，超额 `429 rate-limited` 并计数（阈值要改大得留来源注） |
| 5 | 边界：body ≤16 KB、text ≤4000 字符、等待 ≤120 s（`timeoutMs` 被夹在 2 s–120 s）；等待是**带 deadline 的界内轮询＋回包带前后读数**，不用固定等待换确定性 |

拒绝按原因分档计数留在 `probe`/回包里（`session.denied`），不静默吞。**这一格花的是你的模型额度**，所以三件事绝不做：不铸 token（`authenticatedUrl` 哨兵照旧）、不新建会话、不绕过 allowlist。


六枚路由都经 `webServer.register()` 挂在**插件自己的前缀**上，所以不需要应用的会话 cookie 就能读（与 `/dsh-chamber/*` 同形），并带 `Cache-Control: no-store`。**前四枚只读**（`probe`／`logs`／`faults`／`presets` 只读内存与文件，不写盘、不动会话）；**后两枚动手**——`session` 会花你的额度、`sessions` 会往你 profile 里长资产，所以都要 env key，`sessions` 还要另过五把闸（见上面那张"换轴"表）。

```bash
# 只读三枚：$P 是按上面那格认出来的后端端口（新版随机，别填 19387）
curl -s "http://127.0.0.1:$P/dsh-backroom/probe" | head -c 4000
curl -s "http://127.0.0.1:$P/dsh-backroom/logs?limit=50&level=warn"
curl -s "http://127.0.0.1:$P/dsh-backroom/faults?limit=8"
```

### 摘掉那枚坏插件（走命令行，不走端点）

`tools/fault-triage.mjs`（正本；顶层 `tools/dsh-fault-triage.mjs` 是一行转发壳）——**归因＋隔离**，与 `faults` 端点共用同一份逻辑，不留第二套真相源：

```bash
node tools/dsh-fault-triage.mjs scan --logs "%APPDATA%\@deepseek-ai\dsh-desktop\logs" --source-root E:\dsh-plugins
node tools/dsh-fault-triage.mjs quarantine --bundle auto --profile-dir ~/.dsh/profiles/desktop   # 默认 dry-run
node tools/dsh-fault-triage.mjs quarantine --bundle auto --profile-dir … --logs … --apply        # 才写盘
node tools/dsh-fault-triage.mjs restore --profile-dir … --from <备份件>                          # 逐字节回原
```

- `quarantine` 的语义＝PLUGIN-RULES §C8 的"屏蔽"：**只把包摘出 `dsh.profile.bundles`**，dependency 与安装副本都留着；写之前把原文件逐字备份到**工作区外**（默认 `%TEMP%\dsh-fault-quarantine`），回包带 `backupSha`/`afterSha` 与 restore 命令。
- 两枚闸是硬的：`@deepseek-ai/dsh-base`／`dsh-web-app` 在受保护名单里（拒），不在名册里的名字也拒；被拒的那一发**一个字节都不动**（套件第 08 步量的就是这一格）。
- **生效力度（10-05 实测，别写成免重启）**：这枚工具改的是盘上名册，而名册在**启动时**才组合 ⇒ **要重启**。同一发实验里官方 `pluginManager.setBundleEnabled` 在 CLI `web` 档回的是 `application:"failed"` ＋ `"dsh: profile reload requires the root Include entry"`（盘上改了、纤维没卸）——细节与档位见 `PITFALLS.md` #105 与 `docs/PLUGIN-RULES.md` §H.6 档 1。桌面端是否"live profile"＝**未测**。

## 刻意不做的三件事

- **绝不调用 `connection.authenticatedUrl()`。** 那一枚能铸出带 `?token=` 的 URL，而它只要被兑换一次，就变成了对全部 29 本已发布 `/api` 命名空间的**读写**钥匙。这把钥匙被有意留在宿主进程内：本插件只报"够不够得到"，绝不把钥匙交出去。这条不是注释里的愿望——`test/probe-shape.mjs` 里有一枚会**真的红**的哨兵盯着它。
- **会话那一格按 10-05 的裁定开成了窄口**（原裁定是"绝不碰任何会话"，用户当日改判「开全套窄口」⇒ 现在是"只对登记的会话发 prompt＋读回合面"）。仍然绝不做的是：不 `Session.append` 自定义事件类型（那会毒化整份 durable 日志，PITFALLS #1）、不 `create` 新会话、不 cancel、不切模型、不动队列、不铸 token。发出去的每一发都留痕（`requestId`＋时刻＋拒绝原因分档计数）。
- **绝不杀/重启宿主、前三枚端点绝不写盘、这一版不放任何 UI 席位**（没有 `<style>`、没有面板、没有侧栏入口）。`faults` 那枚**只读**崩溃件目录；唯一会写盘的是命令行里的 `quarantine --apply`，它只动 `dsh.profile.bundles` 那一行、写前先在工作区外逐字备份、且默认是 dry-run。

## 运行要求

- 实测目标 dsh **0.2.0-rc.2**；宿主半是纯 ESM，只用 `node:util`／`node:fs`／`node:path` 三枚内置模块，无第三方依赖。归因逻辑住在本包 `tools/fault-triage.mjs`（已进 `package.json` 的 `files`，`file:` 拷贝才会带上它——少了那枚文件整包 import 失败）。
- 一个会加载 bundle 的 profile（`desktop` / `web`）。

## 安装

1. 把本目录放在一个稳定位置，例如 `C:\plugins\dsh-backroom`。
2. 在 `~/.dsh/profiles/<profile>/package.json` 里同时加两行：

   ```jsonc
   {
     "dependencies": { "dsh-backroom": "file:C:/plugins/dsh-backroom" },
     "dsh": { "profile": { "bundles": [ /* …已有 bundle…, */ "dsh-backroom" ] } }
   }
   ```

3. 用 dsh 自带的 pnpm 安装，然后重启 dsh —— bundle 组合只在启动时解析一次，刷新页面不够：

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-backroom"
   pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>"
   ```

   `file:` 装进来的是**拷贝不是链接**：改了源码不会自己传过去。校验办法是逐枚比对 `lib/**` 的字节数与 sha256（源码树 vs 安装副本）。

## 卸载

删掉上面两行 manifest 条目、删 `node_modules\dsh-backroom`、`pnpm install --dir <profile>`、重启。只想"屏蔽"的话：把 `bundles` 那一行摘掉即可（保留 dependency 与安装副本）。

## 配置

没有"设置页命名空间"那样的东西：**每一把闸都从"你启动 dsh 的那一发进程的环境变量"里读**，所以什么都不落盘，每次启动自己决定开哪一格。启动器（`tools/start-desktop-with-mouth.ps1`）设的就是下面这些，并把它们回打印出来。

| 变量 | 管哪枚端点 | 不设的意思 |
|---|---|---|
| `DSH_BACKROOM_SESSION_KEY` | `session`、`sessions` | 两枚动手端点一律 `403 disabled`（等于不存在） |
| `DSH_BACKROOM_KEY_FILE` | 两枚动手端点的报错提示与入口卡 | 不设＝`no-key` 只能说"在 env 里"，指不出文件；启动器默认把它设成 `%TEMP%\dsh-backroom-key.txt` |
| `DSH_BACKROOM_SESSION_ALLOW` | `session` | 只有本进程刚经 `/sessions` 建出来的那些（owned）可达 |
| `DSH_BACKROOM_WORKSPACE_ROOTS` | `sessions`、`backroom_workspace` 工具 | **建会话整格 `disabled`**；那枚工具报 `disabled` |
| `DSH_BACKROOM_ALLOW_PRESETS` | `sessions` | 不加二次白名单，官面名册本身就是白名单（带 `broken` 的一律拒） |
| `DSH_BACKROOM_DENY_PRESETS` | `session`、`sessions` | 空＝**只逐发回显生效档，不拦**（本机官面默认档就是最宽那一枚，拦它＝新建全废） |
| `DSH_BACKROOM_MAX_SESSIONS_PER_HOUR` | `sessions` | 3 |
| `DSH_BACKROOM_TOKEN_BUDGET` | `session`、`sessions` | 60,000 token（标度＝实测 14,920/回合） |
| `DSH_BACKROOM_WSL_DISTROS` | `backroom_wsl_workspace` 工具 | 那枚工具报 `disabled` |
| `DSH_BACKROOM_BRIDGE_BASE` | `backroom_wsl_workspace` 工具 | 退回"自家路由被访问时的环回 origin"；两样都没有就一个字都不发 |
| `DSH_BACKROOM_CRASH_LOGS` / `DSH_BACKROOM_SOURCE_ROOT` | `faults` | 默认桌面端那一棵 / 只按装侧包归因 |

## 已知边界

- **夹具绿 ≠ 真宿主读数。** `test/probe-shape.mjs` 跑在假 ctx / 真 `console` 对象上，证的是注册、过滤、环形上限、还原与红线哨兵（22 步）；它**不**证明任何关于正在跑的宿主的事实——那些只能来自 `GET /dsh-backroom/probe`，而且那一档是**端点回包**，永远不等于屏上帧。
- **两枚靶会话的下落与那句"可回收"的边界**：`session-bfac01cd…`（`minimal`）与 `session-f8c3752b…`（`ptc`）都已 archive。官面原句是 *"Hide one known Session from Workspace grouping surfaces"* ⇒ **归档＝隐藏，不是删除**；盘上留下什么（sessions 树、projcache、attachments）本窗**没量化**，"侧栏是不是真看不见"也**只有屏帧档能证**、本窗没做。所以这一格只能写成"有官方隐藏通道、残留未量化"，**不许写成"已验证可回收"**（挂在版本账本 `PQ-05`）。
- 日志尾从本插件 `apply()` 那一刻起算。更早的启动期日志能不能看到，取决于探针报的那一发"注册时缓冲里已有几条"（10-04 真宿主＝1 条，而那条正是早于我们 apply 的 `dsh-chamber` 行 ⇒ 缓冲确实能带回放），本插件不去伪造它没看见的东西。
- **探针「只问名字，不动手」**（10-04 事故换来的第一条，正文 `PITFALLS.md #103`、约束 `docs/PLUGIN-RULES.md` §E5）：对外来的官面服务面，本插件只取 `typeof` 与方法名清单，**不调用它们的任何方法**。起因是我自己从探针里调了 `hmr.getLinked()`——那枚方法只在 ESM loader 钩子的现场成立，从 HTTP 处理器里调它会拿 `undefined` 当 url 走 `LoadCache.get`，**抛发生在 loader 的 tick 上、本端 try/catch 拦不到**，后端直接 `dsh: fatal load failure` 退出。探针里那一格现在写成 `not-called（…）` 的说明串，并由套件第 17 步用"出现 `getLinked(` 就红"的哨兵钉住。
- **捕获面有三把界，这是同一次事故的第二条**（约束 §E5b）：① 只接管 `console.error`／`console.warn`——热路径 `log/info/debug` 不接（实测那一帧 28 行里 26 行走 `console.info`，`deepseek-account` 每发请求两发响应各一条）；② 速率闸 **200 条/秒**，超额丢弃并计数，`/logs` 回包里的 `rate` 格把 `reentrantSkips`／`rateDropped`／`captureErrors` 原样带出来；③ 逐参数封顶 **512 字符**、单条 **600 字符**，先各自 slice 再拼，不对整条渲染结果做全局正则。另有**重入闸**：渲染过程中再进来的那一发直接跳过（`util.inspect` 会调用对象自己的 `[util.inspect.custom]`，那里再打一条日志就是自递归）。注意：这三把界是卫生，**不是那次退出的成因**——成因是上面那条越界调用。
- 所以这一档**是有意的近似**：洪峰期间的日志会被丢弃并计入 `rateDropped`。要完整取证就缩小窗口（`limit`／`contains`／`level`），别拿它当审计账本。
- 环形尾由导出的 `createRing(limit)` 实现，默认 4000；淘汰算术在套件里用 `limit=5` 小规模直证——既不靠睡 21 秒填满，也不把默认值调大来凑测试。
- **当前状态（10-19）**：这枚插件**装在用户自己的桌面端 profile 里并跑通了**，实测过两版：0.2.0-rc.2（后端 19387，10-09）与 **0.2.1-rc.2（后端随机，10-19 现读 `12469`／`12750`／`2495`）**。四枚端点全部实测应答；会话入口在真机端到端跑过 prompt，端点读数与独立介质（会话日志里的 `turn/end {reason:"completed"}`）逐一对上。开发期验证一律在**仓外临时实例**（自有 `DSH_HOME`、自有端口）做；真宿主那枚端口只在被授权的同步／重启里被动过——**改完源码要加载新字节仍需重启一次**，这是"会动手的那枚端点"带来的成本。
- **10-19 后半窗的两枚靶会话（诚实账）**：`session-bfac01cd…`（`minimal`＝极简模式）与 `session-f8c3752b…`（`PTC` 模式），cwd 都是 `D:/Temp/backroom-ws`，标题 `backroom:qoder-coordinator*`，各发了一问（`ended:true`、`turn 0→1`、3.4 s、账本现刷 **18,100** token），随后都已 `archive`。**归档＝从分组面摘掉，不是删除**：盘上残留（`~/.dsh/sessions/**`、projcache、attachments）本窗**没量化**，这一格挂在 `docs/compat/VERSIONS/0.2.1-rc.2/MANIFEST.json` 的 `PQ-05`；"侧栏是不是真的看不见了"只有屏帧档能证，本窗没做 ⇒ **不许把这句读成"已验证可回收"**。
- **新版唯一需要我方改的东西不是插件代码，是"判活死的尺"**（10-19 改判，正文 `PITFALLS.md #107`、账本 `docs/compat/VERSIONS/0.2.1-rc.2/` P22）：本包的启动器、README、以及顶层任何拿 19387 判死活的配方都会在新版上**沉默地回"没监听"**。启动器已改成端口发现式（在那族 PID 的监听口里找自家 `/dsh-backroom/probe` 回 200 的那一枚，10-19 真机跑过：3 秒认出 `2495`）。
- 端点免 cookie（本机任意进程可读）。里面不含 token、不含路径之外的敏感值，`DSH_*` 只给名字不给值。
