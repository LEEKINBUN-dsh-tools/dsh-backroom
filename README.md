# dsh-backroom

A read-only **back room** for DeepSeek Harness (`dsh`) plugin authors: it makes the host's own log buffer readable over loopback HTTP, and reports — live, in the running process — which official service faces a plugin can actually reach.

`dsh-backroom` is a community plugin for [DeepSeek Harness](https://www.deepseek.com/). Not an official DeepSeek AI product.

## Why this plugin exists

Two things were missing on the installed desktop host (0.2.0-rc.2), and neither is an API gap:

- **Nobody reads the host's log buffer.** `ctx.logger`'s only built-in sink is cordis' in-memory ring (`logger.buffer`, 1000 entries), and the shipped product registers a second exporter only for the fatal-startup path. Host code logs through `logger`, not `console` (`dsh-hmr` alone emits 19 logger calls), and in the packaged app the backend child's stdout is piped into a GUI process and lost. So "the plugin mounted but did nothing" had no evidence at all.
- **Reachability was measured once and recorded wrong.** Whether `ctx.get('sessionController')` works from a plugin fiber is decided in the running process, not in a `.d.ts` file. This plugin answers that with a live matrix instead of a guess.

## What it does

Current build is the **probe + fault-attribution + narrow session mouth + session-creation** shape: host half only, **six** loopback routes (four read-only, two that act), no UI, and no disk writes from the plugin.

| Route | Returns |
|---|---|
| `GET /dsh-backroom/probe` | Per-service matrix: for each name, `ctx.get(name, true)` / `ctx.get(name, false)` reported separately as `present(<type>)` / `absent` / `threw: <message>`, plus the face's own method names; property-access results for declared vs undeclared deps; `hmr.getLinked()` as-is; how many log records were already buffered before this plugin applied (that is the replayability reading); node/argv/`DSH_*` env **names**; `ctx.fiber.state`. |
| `GET /dsh-backroom/logs?limit=&level=&contains=` | The log tail: everything `ctx.logger` produced since apply **plus** plugin `console.error/warn` output. `level` accepts `error\|info\|warn\|debug` or the official numeric levels 0..3. Ring cap 4000 lines, with the dropped count reported. |
| `GET /dsh-backroom/faults?limit=&dir=` | **Crash attribution**: reads the desktop crash sinks (`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` / `-renderer.log`) and per file returns the first *installed-bundle* frame (the suspect), the first official frame (the face it mis-called), the `dsh: fatal …` cause line and the wrapper line **as two separate fields**. Files with no installed-bundle frame come back with a reason instead of a guess (`renderer-crash` / `no-stack` / `kill-shaped` / `no-installed-bundle-frame`). **`kill-shaped` was added on 10-19** and is the one that matters for the "your write mouth killed my host" claim: `exit=-1` plus no `dsh: fatal` line plus ≤6 frames means *the backend child was taken out from outside* — the same shape a `Stop-Process` restart leaves behind — so the attribution tool **refuses** to blame a plugin for it (`row.killShaped=true`). Default root is the desktop tree; a CLI instance points it with `DSH_BACKROOM_CRASH_LOGS=<dir>`. `dir` must sit inside an allowed root — this route is cookie-free, so it must not become a local file-read oracle; anything else gets **403**. |
| `GET`/`POST /dsh-backroom/session?session=&key=` | **The narrow session mouth (closed by default)**: `GET` reads one allow-listed session's turn face from the projections that are *actually in the public bag* (`turnOutline`, an array of `{turn,seq,prompt,response}`, and `sessionStats.turns`) and returns `turnCount/lastTurn/lastResponseChars/asOfSeq/readable`; `POST` sends one prompt into that **already-registered** session, and `&wait=turn-end&timeoutMs=…` waits until a new turn appears **and** its `response` has been filled by `turn/end`, returning `ended/endedClaim/turnStarted/assistantResponded/waitedMs`. Only the official handlers are used — `sessionController.prompt(request, signal)` / `.projections(request, signal)`, **both arguments required**. Measured end-to-end on the packaged desktop 10-09: one prompt took `turnCount 1→2`, `asOfSeq 19→30`, and the durable log holds exactly two `turn/end reason:"completed"` with two replies. When the criterion cannot be read the route self-reports `endedClaim:"unreadable"` instead of calling it "not finished". (The earlier wording — read `turnBoundary.lastTurn` — was a guess; that unit is not in the public bag. See `docs/PLUGIN-RULES.md` §H.5.) |
| `GET /dsh-backroom/presets` | **Read-only, no key**: the live official roster from `agentPresets.list()` (`{id,name?,description?,order?,broken?}` — activation failures come back *with* their reason) plus `defaultId`, then `permissionPresets.catalog()` (`names`/`options`/`defaultPreset`) and the current state of all five gates. If this machine's default permission preset is the widest one, the route says so in a `permissionWarning`. Measured 10-19 on the packaged desktop: **8 presets** — `standard` (default), `ptc`, `minimal`, `cordis`, plus one `wsl-*` variant of each ⇒ **preset ids are always read at runtime, never hard-coded** (the roster follows the subscription toggle, per the shipped copy: "标准、创造和自定义 … 开启后还提供 PTC 和极简模式"). |
| `GET`/`POST /dsh-backroom/sessions?key=` | **The session-creation route** (user ruling 10-19: *"no model switching — do the rest"*). `POST {cwd \| workspaceId, agentPreset?, caller?}` calls the official `sessionController.create(request)` — the **preset is chosen at creation** (the official `agentPresets.select` jsDoc says verbatim *"Select a preset before a session starts its first turn"*, so an existing session cannot be re-modeled). `POST {op:'archive'\|'unarchive', sessionId}` only ever touches sessions **this plugin created**, via the official `workspaceController.archiveSession`. `GET` returns this process's build-ledger (`owned`/`spendTokens`/quota/budget). Measured twice on the live desktop (`minimal`, then `ptc`): created with title `backroom:<caller>`, one prompt into the fresh session returned `ended:true` (`turn 0→1`, 3.4 s, ledger refreshed to **18,100** tokens), archive returned `archivedNow:true` / `archivedSetSize:13`; out-of-whitelist `cwd` → **403 `cwd-outside-roots`**; trying to archive one of *your* sessions → **403 `not-owned`**. |

All six routes are registered on the plugin's own path prefix through `webServer.register()`, so they answer without the app's session cookie (like `/dsh-chamber/*`). `Cache-Control: no-store`. **The first four are read-only**; the two that act are gated behind an env key, and `sessions` must additionally clear the five gates below. No route writes to disk; the only disk write in this package is the CLI further down, and it writes only after taking a byte-for-byte backup outside the repository.

### One-page usage for another agent (discovery, call format, env, limits)

**How it is discovered** (in order of reliability): ① a model inside dsh sees tool names every turn ⇒ the tool surface carries **`backroom_entry`** (read-only; returns `baseUrl`, the call format of all six routes, every gate and the hard limits); ② any local process can `GET /dsh-backroom/presets` (**no key**); ③ the route table in this README.

**Recognising `baseUrl`** (the port is random since 0.2.1-rc.2): among the listening ports of the `DeepSeek Harness.exe` PID family, take the one whose `GET /dsh-backroom/probe` answers **200**; or just run the launcher, which prints `backend port = …`. **Do not guess the port 0.2.0 hard-coded** — nothing listens there any more (`PITFALLS.md #107`).

**Minimal call sequence** (`$P` = backend port, `$K` = the key the launcher printed):

```bash
# 0) roster (no key): which modes this machine has right now (standard default / ptc / minimal / cordis + four wsl-*)
curl -s "http://127.0.0.1:$P/dsh-backroom/presets"

# 1) create a session (needs the key; cwd must sit under DSH_BACKROOM_WORKSPACE_ROOTS)
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/sessions?key=$K" -H 'content-type: application/json' \
  -d '{"cwd":"D:/Temp/backroom-ws","agentPreset":"minimal","caller":"some-agent"}'
# -> {"sessionId":"session-…","agentPreset":"minimal","titleState":{...},"quota":{...},"permissionPreset":"…"}

# 2) prompt it once (a session this plugin created needs NO edit to DSH_BACKROOM_SESSION_ALLOW)
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/session?key=$K&session=<sid>&wait=turn-end&timeoutMs=90000" \
  -H 'content-type: application/json' -d '{"text":"reply with one word"}'

# 3) read the ledger (what this process built, what it spent, how many slots are left)
curl -s "http://127.0.0.1:$P/dsh-backroom/sessions?key=$K"

# 4) take it back (only sessions this plugin created; archive hides, it does not delete)
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/sessions?key=$K" -H 'content-type: application/json' \
  -d '{"op":"archive","sessionId":"<sid>"}'
```

**Three known traps on the `workspaceId` branch** (added 10-30 after another session ran it for real):
1. **Fill roots with the host-canonical form**: read `tables.workspaces[<id>].path` from `<DSH_HOME>/storages/workspace.json` first — the host stores it with **upper-case drive/directories** (measured `D:\TEMP\issue129-real\fixture-ws` while the operator had typed `D:\Temp\…`) — then use *that* prefix for `DSH_BACKROOM_WORKSPACE_ROOTS`. `rootGate` folds case on win32 and normalises `\` to `/`, but both shapes have to point at the same directory, and that is on the caller to get from the record.
2. **`create` can leave a session behind**: the official call may create the session and only then fail to attach it (exact wording `session "…" was created but could not attach to workspace …`, which happens when the paths differ in case). The failure reply carries **`orphanSessionId`**; it is **not** in this plugin's `owned` ledger and this plugin will not archive it for you — clean it up in the sidebar/workspace, or call the official `archiveSession` by that id yourself.
3. **Model/credentials are out of scope**: a turn can end with `turn/end.reason.kind = "error"` (e.g. the provider key returns 401); then `spendTokens = 0` and `tool/call = 0`. Our `ended` criterion is **`turnCount` increased and `lastResponseChars > 0`**, so an errored turn reads as `ended:false` — check the durable log's `turn/end.reason` before concluding "it never ran". Also, the measured **14,920 tokens/turn is a `sensenova/deepseek-v4-flash` figure** (desktop); it does not transfer to another provider or to a turn that runs bash tools.

**How to carry the key** (added 10-19 after a real report: another agent passed the key in a header and still got `no-key`, because only `?key=` was accepted): pick one of `?key=<k>`, header `x-backroom-key: <k>`, or `Authorization: Bearer <k>` — **a header is the recommended form** (query strings end up in logs). Another agent does not need to know the value: by default the launcher **writes it to a readable file** (`%TEMP%\dsh-backroom-key.txt`, override with `-KeyFile`; `-Ephemeral` keeps the old mint-and-forget behaviour) and exports that path as `DSH_BACKROOM_KEY_FILE`; if the file is missing, the `no-key` reply names the path. To be plain about the security: **any local process can read that file** — it stops slips and unauthenticated callers, not a hostile local process. The real boundaries stay the five gates (allow-list, roots, quota, budget, owned).

**Env**: see the Configuration table below (each gate's meaning and what "unset" does).

**Limits (for the next agent — do not treat it as a universal remote)**:

- `session` / `sessions` are **not model tools** ⇒ a model inside dsh cannot create sessions or send prompts by itself; an external process (your agent, CI, a script) must call HTTP with the key.
- **No model switching**, **no permission-preset writes** (there is no `permissionPresets.set` in this package at all), **no deleting sessions** (the official archive only hides; disk residue is unmeasured).
- Budget / quota / ledger are **per process**: restart clears `owned` and resets the hourly slots; it is not an audit log ("who built what yesterday" is not answerable).
- Sending is bounded: 6 prompts/minute, text ≤4000 chars, wait 2–120 s; creating is 3/hour; budget defaults to 60,000 tokens (≈4 measured turns).
- Prompting an archived session → 403 (it left `owned`); archiving **someone else's** session → 403 `not-owned`; an unreadable permission preset is reported (`permissionGate:"unknown-preset"`) but does not block.

### Debugging inside the built-in browser (web instance + composer injection, proven 10-30)

Usually lighter than opening the desktop app: start **your own** `--profile web` instance, open its token URL in the built-in browser, and inject into the composer from in-page JS. Three facts decide the approach: **the composer is Lexical** (`data-lexical-editor="true"`) so `execCommand` returns false and the text stays empty; **a CLI `web` instance has no Chromium**, therefore no CDP to attach to; **`contenteditable="false"` until a workspace is selected**.

```bash
# 1) start an instance (it creates the workspace and prints the url; you export the key, the tool never reads ~/.dsh)
export SENSANOVA_TOKEN_PLAN_API_KEY=<same value the desktop uses>
node dsh-backroom/tools/web-debug.mjs start \
  --home D:/Temp/dsh-web-debug/home --workspace D:/Temp/dsh-web-debug/ws \
  --port 3981 --key-env SENSANOVA_TOKEN_PLAN_API_KEY \
  --preset-file <a copy of the desktop profile's cordis.patch.yml>   # makes new sessions land on sensenova
# 2) open the printed url in the built-in browser, dismiss the two first-run modals, select the workspace
# 3) print the injection snippet (ONE beforeinput only; adding input doubles the text)
node dsh-backroom/tools/web-debug.mjs snippet
# 4) clean up
node dsh-backroom/tools/web-debug.mjs stop --home D:/Temp/dsh-web-debug/home
```

The core of the injection (`snippet` prints the full version):

```js
const ed = document.querySelector('[contenteditable][data-lexical-editor]');
ed.focus();
const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
const s = getSelection(); s.removeAllRanges(); s.addRange(r);
ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'reply with one word', bubbles: true, cancelable: true, composed: true }));
[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === '发送消息').click();
```

Three traps: `execCommand` never works on Lexical; dispatching **both** `beforeinput` and `input` doubles the text (measured `HELLO-BHELLO-B`); and `innerWidth/innerHeight=0` / `visibilityState:"hidden"` do **not** block this JS path (they only block trusted click/hover/screenshots).

Measured on this machine: inject → send → `sensenova / DeepSeek V4 Flash` replied **“好” in 16 s**, **9.4K tok**; the tool's `start` returned in **5.7 s** with the workspace already created. **Bounds**: the temp home must live outside the repo (the tool refuses `--home` under `~/.dsh`), `stop` only kills the pid it recorded, and nothing touches your desktop app or `~/.dsh`.

### Why the constraints changed axis (this paragraph answers "isn't your safety rule a fake?")

The user's challenge, verbatim: *"you send to dsh and it spends money, versus dsh spending money itself — isn't that the same? Is 'never give an arbitrary session a button that spends your quota' safety, or laziness?"* **On the money axis he is right**, and the old red line was mis-named: spending is not asymmetric — the bill lands in the same pocket either way. What actually moves out of his hands is three other things: **which directory the session is attached to, which permission preset is in force, and whether what got created can be taken back**. So the constraint changed axis instead of being dropped — five gates, each one an **exported pure function** (unit-tested, not "we'll be careful"):

| Gate | What it is made of | Default and where the number comes from |
|---|---|---|
| Scope | `rootGate` — the same allow-list the workspace route uses (`DSH_BACKROOM_WORKSPACE_ROOTS`) | **unset ⇒ the whole create route is `disabled`**; `cwd` outside the roots → 403 |
| Roster | `presetGate(agentPresets.list(), wanted, DSH_BACKROOM_ALLOW_PRESETS)` | the id must be present **right now** and not `broken`; unreadable roster → 502 `roster-unavailable` (never guess an id into someone's session) |
| Quota | `hourWindow(limit)`, `DSH_BACKROOM_MAX_SESSIONS_PER_HOUR` | **3/hour** — each creation grows an asset in his profile and archiving only hides it; a later gate failing calls `undo()` so one bad path does not burn the hour |
| Budget | `budgetGate(cumulative tokenUsage, DSH_BACKROOM_TOKEN_BUDGET)` | **60,000** with a measured scale: the target session's four turns were **13,762 / 13,847 / 14,794 / 17,276** (mean **14,920**) ⇒ ≈4 turns. Applies only to sessions **this plugin created** (your own sessions' spend is already in the stream; the plugin is not their bookkeeper) |
| Preset | `denyGate(permissions projection currentValue, DSH_BACKROOM_DENY_PRESETS)` | **empty list by default = display, do not block**: this machine's `catalog().defaultPreset` measured `danger-full-access`, so blocking the default would make every created session useless — that is moving the locked door, not constraining anything. A real block is opt-in by name |

"Never widen a permission preset" is **not** enforced by guessing defaults: it is structural — there is no `permissionPresets.set` call anywhere in this package, the sentinel whitelists each face (`pp` may only `catalog`, `agentPresets` only `list`) and carries a synthetic control that goes red when `pp.set(` is pasted back in. Two things deliberately still missing: switching models (`session/selectModel` changes the price of every later turn) and exposing `session`/`sessions` as model tools (no session gets a button that creates sessions).

About "taking it back", honestly: the official wording is *"Hide one known Session from Workspace grouping surfaces"* ⇒ **archive is not delete**, and this window never measured what stays on disk (tracked as `PQ-05` in the version ledger); and the call returns the **whole archive set** (13 entries here, 12 of them yours already), which is why the route computes `archivedNow` itself instead of letting the set size read like "I archived 13" — see `PITFALLS.md #108`.

### What "narrow mouth" means (plain words, no jargon)

**It is a door that is locked unless you start dsh with a key.** The first three routes only look; the fourth one can put a message into one of your conversations, which touches your data and spends your quota. So it does not "start open and behave yourself" — with no key set it answers `403 disabled` and is effectively absent:

1. no `DSH_BACKROOM_SESSION_KEY` in the environment when dsh starts ⇒ every call is refused;
2. the session must appear in `DSH_BACKROOM_SESSION_ALLOW` **or** be one this process just created through `/sessions` (`owned`) ⇒ it never picks "the most recent session" for you, and it never touches a session it did not build (verified both ways: after archiving its own session the mouth stops accepting it; archiving one of yours returns `not-owned`);
3. even then: 6 prompts/minute, text ≤ 4000 chars, body ≤ 16 KB, a wait capped at 120 s.

"Narrow" = it can only send text into a session you named (or one it just built for you), and read whether that turn finished. It cannot switch models, cancel, edit queues, or mint a token — and the suite fails the build if a second prompt call site appears or any face outside the per-service whitelist is called (`agentPresets` may only `list`; `permissionPresets` may only `catalog`; there is no `set` anywhere).

Daily use, safety first and little friction:

```powershell
# normal day: just start dsh from its icon. The door is closed; the four read-only routes work.
# when you do want to send one:
powershell -File tools\start-desktop-with-mouth.ps1 -Sid <your session id>
# and if you also want the create-session route open for this run (without -Roots it stays disabled):
powershell -File tools\start-desktop-with-mouth.ps1 -Sid <your session id> -Roots "D:/Temp/backroom-ws" -MaxSessions 3 -Budget 60000
#  -> it mints a one-run key and prints it (never stored on disk, gone when the app exits),
#     stops the running instance, restarts it with that env, *discovers* the backend port,
#     prints the gate summary, and prints the exact curl lines to paste (probe/mouth/roster/create/ledger).
```

**The backend port is no longer fixed (measured 10-19).** Release 0.2.0-rc.2 hard-coded `19387`; **0.2.1-rc.2 changed `dsh-desktop-host` to pass `--port 0`, so the OS assigns a fresh port every boot** (seven values on one machine this window: `12469`, `12750`, `2495`, `4606`, `9381`, `9732`, `9960`). Consequence worth knowing: a liveness check that asks *"is 19387 listening?"* does not fail loudly on the new release — it answers *"nothing is listening"* forever, which is exactly how "the write mouth crashed my host" nearly got written down as fact. The shipped launcher therefore discovers the port instead: among the ports the `DeepSeek Harness.exe` PID family owns, the backend is the one whose `GET /dsh-backroom/probe` answers **200** (cookie-free). Without this plugin, take the one answering **401** with the official sentence `dsh web authentication required; reopen the URL printed by dsh web.` ⚠ The same PID family also owns **`9230`** on 0.2.1-rc.2 — that is the official inspector's CDP endpoint (`/json/version` reports `Browser:"dsh-experimental-inspector/0"`) and answers **404** on `/`; it is neither the backend nor a dead host. Ledger: `docs/compat/VERSIONS/0.2.1-rc.2/` P22/P28; `PITFALLS.md #107`.

Why not keep the key in your user environment variables: that copy is plaintext, readable by any local process and by roaming/profile backups. Not persisting it buys *default-closed* plus *no stored secret* — it is a smaller exposure surface, not absolute security (a process that can read your env can already read your cookies).

### How a model inside dsh uses it (the agent tool surface)

The read-only routes need no cookie, but **a model in a session does not know that port exists** — without a tool surface only a prompt that was told about it can use it. So the read-only capabilities are additionally registered as official `defineTool` tools (taken via `ctx.get('tools', false)`; if that service is absent the plugin reports `absent` and still mounts instead of hard-depending on it):

| Tool | What it does | Gate |
|---|---|---|
| `backroom_probe` | host shape: reachability matrix plus this plugin's own counters, including the session mouth's refusal ledger | none, read-only |
| **`backroom_entry`** | **The entry card**: how to recognise the backend port, the call format of all six routes, every env gate, and the hard limits (no model switching / not tools / archive only hides). **This is how another agent discovers the entry** — tool names are what a model actually sees each turn | none, read-only |
| `backroom_logs` | host log tail (`limit/level/contains`) | none, read-only |
| `backroom_faults` | crash-log attribution (`limit/dir`) | none, read-only |
| `backroom_workspace` | `list` the profile's workspaces, or `create` one through the official `workspaceController.create` (an existing path comes back `created:false`) | **yes**: `DSH_BACKROOM_WORKSPACE_ROOTS` (prefix list); unset ⇒ `disabled` |
| `backroom_wsl_workspace` | `distros`/`ls`/`check` via `dsh-wsl-workspace`'s own loopback bridge; `create` composes in the order that plugin's client uses (official create, then its `registerWindows`/`setUser`) | `create`: `DSH_BACKROOM_WSL_DISTROS`; the three reads need nothing. **Which port the bridge targets** (changed 10-19): explicit `DSH_BACKROOM_BRIDGE_BASE` > the loopback origin our own route was just requested through (from its `Host` header) > neither, in which case **not a byte is sent** and the reply says `bridge-base-unknown`. The old fallback guessed a hard-coded `19387`, which on new releases is an empty port and read as "the bridge is broken". `GET /dsh-backroom/probe` now carries a `bridge` field showing which of the three it would use. |
| — | **`session` and `sessions` are deliberately not tools** | safety first, and now with a stated reason instead of a slogan: a session that can create sessions can also grow assets and spend quota without a named operator behind it. The quota/budget gates are per-process and would be trivially satisfied from inside a running agent, so the human decision stays on the HTTP side. |

Two design notes: ① the WSL path **does not copy another plugin's private state** — `~/.dsh/wsl-workspaces.json` belongs to `dsh-wsl-workspace`, and we only delegate in its own call order; if the official create fails, registration is never attempted (no half-done workspace), and if registration fails the reply says so rather than reporting success. ② Path mapping (`/mnt/e/tmp` → `E:\tmp`, otherwise `\\wsl.localhost\<distro>\…`) and both allow-list checks are **exported pure functions** unit-tested directly, including "`E:/ab` is not inside `E:/a`".

**Proven about the tool surface** (packaged desktop, 10-09): `GET /dsh-backroom/probe` reports `toolsState.status="registered(5)"`, `lastError:""`, and independently the newest `request/header.tools` frame in the durable session log lists all five while the two frames from before the restart list none — "registered" and "handed to the model" were measured separately, and the first is never used to claim the second.


### The five gates on the session mouth


```bash
# set before starting dsh — without them the route is as if it did not exist
DSH_BACKROOM_SESSION_KEY=<a local secret>
DSH_BACKROOM_SESSION_ALLOW=<sessionId1,sessionId2>
# $P = the backend port, recognised as described above (random since 0.2.1-rc.2; the launcher prints it)
curl -s -X POST "http://127.0.0.1:$P/dsh-backroom/session?key=…&session=<listed id>&wait=turn-end&timeoutMs=60000" \
     -H 'content-type: application/json' -d '{"text":"reply with one word"}'
```

1. no `DSH_BACKROOM_SESSION_KEY` ⇒ `403 disabled`; 2. `?key=` compared with `crypto.timingSafeEqual` ⇒ `403 bad-key`;
3. `sessionId` must be in `DSH_BACKROOM_SESSION_ALLOW` ⇒ `403 not-allowlisted`, and **never** `session/create` (a sentinel fails the build if it appears);
4. rate gate: 6 prompts/minute by default, excess gets `429 rate-limited` and is counted;
5. bounds: body ≤ 16 KB, text ≤ 4000 chars, wait clamped to 2 s–120 s. Waiting is a **deadline-bounded poll on the official projection that returns the readings** (`before`/`after`/`waitedMs`/`deadlineMs`), not a fixed sleep pretending to be determinism; refusals are counted per reason, never swallowed.

```bash
# read-only three: $P is the backend port you just recognised (random on new releases — do not paste 19387)
curl -s "http://127.0.0.1:$P/dsh-backroom/probe" | head -c 4000
curl -s "http://127.0.0.1:$P/dsh-backroom/logs?limit=50&level=warn"
curl -s "http://127.0.0.1:$P/dsh-backroom/faults?limit=8"
```

### Quarantining the plugin that broke

`tools/fault-triage.mjs` (authoritative copy; the top-level `tools/dsh-fault-triage.mjs` is a one-line forwarder) shares its attribution logic with the `faults` route, so there is no second source of truth:

```bash
node tools/dsh-fault-triage.mjs scan --logs "%APPDATA%\@deepseek-ai\dsh-desktop\logs" --source-root E:\dsh-plugins
node tools/dsh-fault-triage.mjs quarantine --bundle auto --profile-dir ~/.dsh/profiles/desktop          # dry-run
node tools/dsh-fault-triage.mjs quarantine --bundle auto --profile-dir … --logs … --apply              # writes
node tools/dsh-fault-triage.mjs restore --profile-dir … --from <backup>                                # byte-identical revert
```

- `quarantine` implements the **"mask"** semantics of `docs/PLUGIN-RULES.md` §C8: it drops the package from `dsh.profile.bundles` only — the dependency entry and the installed copy stay.
- Two hard refusals: `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` are protected, and a name that is not in the list is rejected. A refused call changes **zero bytes** (suite step 08 measures exactly that).
- **How it takes effect (measured 10-05 — do not claim hot-reload)**: the bundle roster is composed at start-up, so **a restart is required**. In the same experiment, the official `pluginManager.setBundleEnabled` returned `application:"failed"` with `"dsh: profile reload requires the root Include entry"` on a CLI `web` instance (disk changed, fiber kept running). See `PITFALLS.md` #105 and `docs/PLUGIN-RULES.md` §H.6 tier 1. Whether the packaged desktop is a "live profile" is **untested**.


## What it deliberately does not do

- **It never invokes a method on another package's service face.** The probe reports `typeof` and method names only. Reason: on 10-04 this plugin called `hmr.getLinked()` from the probe handler; that method only holds inside dsh-hmr's ESM-loader hook context, so it reached `LoadCache.get` with an `undefined` url, threw on a loader tick **outside our own try/catch**, and took the backend down with `dsh: fatal load failure` (full stack in `PITFALLS.md` #103; the rule is `docs/PLUGIN-RULES.md` §E5). A test step now fails the build if `getLinked(` / `watchConfig(` / `runExclusive(` / `authenticatedUrl(` appear in the code.
- **It never calls `connection.authenticatedUrl()`.** That face mints a `?token=` URL which, redeemed once, becomes a cookie granting write access to all 29 published `/api` namespaces. The token is deliberately kept inside the host process: this plugin exposes what it *can* reach, never the key. `test/probe-shape.mjs` asserts this as a failing gate, not as a comment.
- **Sessions: only through the two gated routes, and only forward.** History of the ruling, so nobody re-hardens the wrong thing: 10-04 "never touch a session" → 10-05 "开全套窄口" (prompts into an allow-listed session) → **10-19 "不需要切换模型，其他做完"** (creating sessions is allowed *with the five gates*, and the reason the earlier blanket ban was half a fake is in the section above). Still never done: `Session.append` of custom event types (that poisons the whole durable log), `session/selectModel` / `modelCatalog` writes (model switching changes the price of every later turn), cancel, queue edits, token minting, and **any permission-preset write** — there is no `permissionPresets.set` call in this package, which is what "never widen" actually means here. Every admitted prompt or creation leaves a trace (`requestId` / `sessionId` + timestamp + caller), and every refusal is counted by reason.
- **It never kills or restarts the host**, and its routes write no files. `faults` only reads the crash-log directory; the single writing path is the CLI `quarantine --apply`, which touches only the `dsh.profile.bundles` line, backs the file up outside the repo first, and is dry-run by default.
- **No UI seat in this build.** No `<style>`, no panel, no sidebar entry.

## Requirements

- dsh **0.2.0-rc.2 and 0.2.1-rc.2** verified on the packaged desktop (10-09 and 10-19); host half is plain ESM using only `node:util` / `node:fs` / `node:path`. ⚠ The backend port is fixed (`19387`) only on 0.2.0-rc.2 — from 0.2.1-rc.2 it is assigned per boot, see "The backend port is no longer fixed" above.
- Attribution logic lives in `tools/fault-triage.mjs`, which is inside `package.json` `files` — a `file:` install that omits that file fails the whole package import. ⚠ The `faults` route **statically imports** it, so editing it needs one host restart before the route agrees with the CLI (`docs/PLUGIN-RULES.md` §H.6 2b).
- A profile that loads bundles (`desktop` / `web`).

## Install

1. Put this directory somewhere stable, e.g. `C:\plugins\dsh-backroom`.
2. In `~/.dsh/profiles/<profile>/package.json` add both entries:

   ```jsonc
   {
     "dependencies": { "dsh-backroom": "file:C:/plugins/dsh-backroom" },
     "dsh": { "profile": { "bundles": [ /* …existing bundles…, */ "dsh-backroom" ] } }
   }
   ```

3. Reinstall with the pnpm that ships with dsh, then restart dsh — bundle composition is resolved at start, a page reload is not enough:

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-backroom"
   pnpm install --dir "$env:USERPROFILE\.dsh\profiles\<profile>"
   ```

   `file:` installs are **copies**, not links: changing source files never propagates by itself. Verify by comparing bytes + sha256 of `lib/**` in the tree and in the install copy.

## Uninstall

Remove the two manifest entries, delete `node_modules\dsh-backroom`, `pnpm install --dir <profile>`, restart. Masking (dropping only the `bundles` line, keeping the dependency) also works and leaves the install copy in place.

## Configuration

No settings namespace: everything is read from the **environment of the process you start dsh from**, so nothing is persisted and each run decides what to open. The launcher (`tools/start-desktop-with-mouth.ps1`) sets exactly these and prints them back.

| Variable | Route(s) | Unset means |
|---|---|---|
| `DSH_BACKROOM_SESSION_KEY` | `session`, `sessions` | both acting routes answer `403 disabled` (they do not exist) |
| `DSH_BACKROOM_KEY_FILE` | the `no-key` hint and the entry card | unset ⇒ the hint can only point at the env var; the launcher sets it to `%TEMP%\dsh-backroom-key.txt` by default |
| `DSH_BACKROOM_SESSION_ALLOW` | `session` | only sessions this process created (`owned`) are reachable |
| `DSH_BACKROOM_WORKSPACE_ROOTS` | `sessions`, `backroom_workspace` tool | create is `disabled`; the workspace tool reports `disabled` |
| `DSH_BACKROOM_ALLOW_PRESETS` | `sessions` | the official roster is the allow-list (nothing `broken`) |
| `DSH_BACKROOM_DENY_PRESETS` | `session`, `sessions` | empty ⇒ the in-force preset is displayed per call, never blocked |
| `DSH_BACKROOM_MAX_SESSIONS_PER_HOUR` | `sessions` | 3 |
| `DSH_BACKROOM_TOKEN_BUDGET` | `session`, `sessions` | 60,000 tokens (measured scale: 14,920/turn) |
| `DSH_BACKROOM_WSL_DISTROS` | `backroom_wsl_workspace` tool | that tool reports `disabled` |
| `DSH_BACKROOM_BRIDGE_BASE` | `backroom_wsl_workspace` tool | fall back to the loopback origin our own route was requested through; if neither, send nothing |
| `DSH_BACKROOM_CRASH_LOGS` / `DSH_BACKROOM_SOURCE_ROOT` | `faults` | default desktop crash tree / attribute only against installed copies |


## Known boundaries

- **Fixture green ≠ real-host reading.** `test/probe-shape.mjs` runs against a fake `console`/ctx and proves registration, filtering, ring cap, disposal and the red-line sentinels (22 steps). It does not prove anything about the running host; those readings come from `GET /dsh-backroom/probe`, and they are the *endpoint* tier, never a screen frame.
- **"Reclaimable" is weaker than it sounds.** The two target sessions this window built (`session-bfac01cd…` in `minimal`, `session-f8c3752b…` in `ptc`, both `cwd: D:/Temp/backroom-ws`) are archived, and the official wording is *"Hide one known Session from Workspace grouping surfaces"* ⇒ **archive hides, it does not delete**. What remains on disk (session tree, projcache, attachments) was **not measured**, and "does the sidebar really stop showing it" can only be proven by a screen frame, which this window did not take. Tracked as `PQ-05` in the version ledger — do not upgrade it to "verified reclaimable".
- **The create-ledger (`owned`, quota, spend) lives in one process.** It resets on restart and only counts sessions *this* process created — that is the ownership boundary working, not a bug, but it also means the ledger is not an audit log of everything ever built.
- The log tail starts at this plugin's `apply()`. Boot-time lines that happened earlier are only visible if they are still in `logger.buffer` — the probe reports whether that replay channel exists rather than assuming it.
- `console` is wrapped while this plugin is mounted and restored on dispose; a second mount does not stack a second wrapper. Other tools that patch `console` are left alone both ways.
- Process-level facts (`argv`, env names) are reported without values, and anything matching `token` is filtered out of `argv`.
