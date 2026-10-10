# dsh-backroom

A read-only **back room** for DeepSeek Harness (`dsh`) plugin authors: it makes the host's own log buffer readable over loopback HTTP, and reports — live, in the running process — which official service faces a plugin can actually reach.

`dsh-backroom` is a community plugin for [DeepSeek Harness](https://www.deepseek.com/). Not an official DeepSeek AI product.

## Why this plugin exists

Two things were missing on the installed desktop host (0.2.0-rc.2), and neither is an API gap:

- **Nobody reads the host's log buffer.** `ctx.logger`'s only built-in sink is cordis' in-memory ring (`logger.buffer`, 1000 entries), and the shipped product registers a second exporter only for the fatal-startup path. Host code logs through `logger`, not `console` (`dsh-hmr` alone emits 19 logger calls), and in the packaged app the backend child's stdout is piped into a GUI process and lost. So "the plugin mounted but did nothing" had no evidence at all.
- **Reachability was measured once and recorded wrong.** Whether `ctx.get('sessionController')` works from a plugin fiber is decided in the running process, not in a `.d.ts` file. This plugin answers that with a live matrix instead of a guess.

## What it does

Current build is the **probe + fault-attribution + narrow session mouth** shape: host half only, four loopback routes, no UI, and no disk writes from the plugin.

| Route | Returns |
|---|---|
| `GET /dsh-backroom/probe` | Per-service matrix: for each name, `ctx.get(name, true)` / `ctx.get(name, false)` reported separately as `present(<type>)` / `absent` / `threw: <message>`, plus the face's own method names; property-access results for declared vs undeclared deps; `hmr.getLinked()` as-is; how many log records were already buffered before this plugin applied (that is the replayability reading); node/argv/`DSH_*` env **names**; `ctx.fiber.state`. |
| `GET /dsh-backroom/logs?limit=&level=&contains=` | The log tail: everything `ctx.logger` produced since apply **plus** plugin `console.error/warn` output. `level` accepts `error|info|warn|debug` or the official numeric levels 0..3. Ring cap 4000 lines, with the dropped count reported. |
| `GET /dsh-backroom/faults?limit=&dir=` | **Crash attribution**: reads the desktop crash sinks (`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` / `-renderer.log`) and per file returns the first *installed-bundle* frame (the suspect), the first official frame (the face it mis-called), the `dsh: fatal …` cause line and the wrapper line **as two separate fields**. Files with no installed-bundle frame come back with a reason instead of a guess (`renderer-crash` / `no-stack` / `no-installed-bundle-frame`). Default root is the desktop tree; a CLI instance points it with `DSH_BACKROOM_CRASH_LOGS=<dir>`. `dir` must sit inside an allowed root — this route is cookie-free, so it must not become a local file-read oracle; anything else gets **403**. |

| `GET`/`POST /dsh-backroom/session?session=&key=` | **The narrow session mouth (closed by default)**: `GET` reads one allow-listed session's turn face from the projections that are *actually in the public bag* (`turnOutline`, an array of `{turn,seq,prompt,response}`, and `sessionStats.turns`) and returns `turnCount/lastTurn/lastResponseChars/asOfSeq/readable`; `POST` sends one prompt into that **already-registered** session, and `&wait=turn-end&timeoutMs=…` waits until a new turn appears **and** its `response` has been filled by `turn/end`, returning `ended/endedClaim/turnStarted/assistantResponded/waitedMs`. Only the official handlers are used — `sessionController.prompt(request, signal)` / `.projections(request, signal)`, **both arguments required**. Measured end-to-end on the packaged desktop 10-09: one prompt took `turnCount 1→2`, `asOfSeq 19→30`, and the durable log holds exactly two `turn/end reason:"completed"` with two replies. When the criterion cannot be read the route self-reports `endedClaim:"unreadable"` instead of calling it "not finished". (The earlier wording — read `turnBoundary.lastTurn` — was a guess; that unit is not in the public bag. See `docs/PLUGIN-RULES.md` §H.5.) |

All four routes are registered on the plugin's own path prefix through `webServer.register()`, so they answer without the app's session cookie (like `/dsh-chamber/*`). `Cache-Control: no-store`. **The first three are read-only**; the fourth spends your model quota, which is why it is gated behind two environment variables and refuses to create sessions. No route writes to disk; the only disk write in this package is the CLI below, and it writes only after taking a byte-for-byte backup outside the repository.

### What "narrow mouth" means (plain words, no jargon)

**It is a door that is locked unless you start dsh with a key.** The first three routes only look; the fourth one can put a message into one of your conversations, which touches your data and spends your quota. So it does not "start open and behave yourself" — with no key set it answers `403 disabled` and is effectively absent:

1. no `DSH_BACKROOM_SESSION_KEY` in the environment when dsh starts ⇒ every call is refused;
2. the session must appear in `DSH_BACKROOM_SESSION_ALLOW` ⇒ it never picks "the most recent session" for you and **never creates a session**;
3. even then: 6 prompts/minute, text ≤ 4000 chars, body ≤ 16 KB, a wait capped at 120 s.

"Narrow" = it can only send text into a session you named, and read whether that turn finished. It cannot switch models, cancel, edit queues, or mint a token — and the test suite fails the build if a second call site or a `create` appears.

Daily use, safety first and little friction:

```powershell
# normal day: just start dsh from its icon. The door is closed; the three read-only routes work.
# when you do want to send one:
powershell -File tools\start-desktop-with-mouth.ps1 -Sid <your session id>
#  -> it mints a one-run key and prints it (never stored on disk, gone when the app exits),
#     stops the running instance, restarts it with that env, waits for port 19387,
#     and prints the exact curl line to paste.
```

Why not keep the key in your user environment variables: that copy is plaintext, readable by any local process and by roaming/profile backups. Not persisting it buys *default-closed* plus *no stored secret* — it is a smaller exposure surface, not absolute security (a process that can read your env can already read your cookies).

### How a model inside dsh uses it (the agent tool surface)

The read-only routes need no cookie, but **a model in a session does not know that port exists** — without a tool surface only a prompt that was told about it can use it. So the read-only capabilities are additionally registered as official `defineTool` tools (taken via `ctx.get('tools', false)`; if that service is absent the plugin reports `absent` and still mounts instead of hard-depending on it):

| Tool | What it does | Gate |
|---|---|---|
| `backroom_probe` | host shape: reachability matrix plus this plugin's own counters, including the session mouth's refusal ledger | none, read-only |
| `backroom_logs` | host log tail (`limit/level/contains`) | none, read-only |
| `backroom_faults` | crash-log attribution (`limit/dir`) | none, read-only |
| `backroom_workspace` | `list` the profile's workspaces, or `create` one through the official `workspaceController.create` (an existing path comes back `created:false`) | **yes**: `DSH_BACKROOM_WORKSPACE_ROOTS` (prefix list); unset ⇒ `disabled` |
| `backroom_wsl_workspace` | `distros`/`ls`/`check` via `dsh-wsl-workspace`'s own loopback bridge; `create` composes in the order that plugin's client uses (official create, then its `registerWindows`/`setUser`) | `create`: `DSH_BACKROOM_WSL_DISTROS`; the three reads need nothing |
| — | **the `session` route is deliberately not a tool** | safety first: no session gets a button that spends your quota |

Two design notes: ① the WSL path **does not copy another plugin's private state** — `~/.dsh/wsl-workspaces.json` belongs to `dsh-wsl-workspace`, and we only delegate in its own call order; if the official create fails, registration is never attempted (no half-done workspace), and if registration fails the reply says so rather than reporting success. ② Path mapping (`/mnt/e/tmp` → `E:\tmp`, otherwise `\\wsl.localhost\<distro>\…`) and both allow-list checks are **exported pure functions** unit-tested directly, including "`E:/ab` is not inside `E:/a`".

**Proven about the tool surface** (packaged desktop, 10-09): `GET /dsh-backroom/probe` reports `toolsState.status="registered(5)"`, `lastError:""`, and independently the newest `request/header.tools` frame in the durable session log lists all five while the two frames from before the restart list none — "registered" and "handed to the model" were measured separately, and the first is never used to claim the second.


### The five gates on the session mouth


```bash
# set before starting dsh — without them the route is as if it did not exist
DSH_BACKROOM_SESSION_KEY=<a local secret>
DSH_BACKROOM_SESSION_ALLOW=<sessionId1,sessionId2>
curl -s -X POST "http://127.0.0.1:19387/dsh-backroom/session?key=…&session=<listed id>&wait=turn-end&timeoutMs=60000" \
     -H 'content-type: application/json' -d '{"text":"reply with one word"}'
```

1. no `DSH_BACKROOM_SESSION_KEY` ⇒ `403 disabled`; 2. `?key=` compared with `crypto.timingSafeEqual` ⇒ `403 bad-key`;
3. `sessionId` must be in `DSH_BACKROOM_SESSION_ALLOW` ⇒ `403 not-allowlisted`, and **never** `session/create` (a sentinel fails the build if it appears);
4. rate gate: 6 prompts/minute by default, excess gets `429 rate-limited` and is counted;
5. bounds: body ≤ 16 KB, text ≤ 4000 chars, wait clamped to 2 s–120 s. Waiting is a **deadline-bounded poll on the official projection that returns the readings** (`before`/`after`/`waitedMs`/`deadlineMs`), not a fixed sleep pretending to be determinism; refusals are counted per reason, never swallowed.

```bash
curl -s http://127.0.0.1:19387/dsh-backroom/probe | head -c 4000
curl -s "http://127.0.0.1:19387/dsh-backroom/logs?limit=50&level=warn"
curl -s "http://127.0.0.1:19387/dsh-backroom/faults?limit=8"
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
- **Sessions: only through the gated mouth.** The original ruling for this plugin was "never touch a session"; on 10-05 the user re-ruled it to "开全套窄口" (open the full set, narrow mouth), so the plugin now sends prompts **only into an allow-listed, pre-existing session** and reads its turn face. Still never done: `Session.append` of custom event types (that poisons the whole durable log), `session/create`, cancel, model switch, queue edits, token minting. Every admitted prompt leaves a trace (`requestId` + timestamp), and every refusal is counted by reason.
- **It never kills or restarts the host**, and its routes write no files. `faults` only reads the crash-log directory; the single writing path is the CLI `quarantine --apply`, which touches only the `dsh.profile.bundles` line, backs the file up outside the repo first, and is dry-run by default.
- **No UI seat in this build.** No `<style>`, no panel, no sidebar entry.

## Requirements

- dsh **0.2.0-rc.2** verified target; host half is plain ESM using only `node:util` / `node:fs` / `node:path`.
- Attribution logic lives in `tools/fault-triage.mjs`, which is inside `package.json` `files` — a `file:` install that omits that file fails the whole package import.
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

None in this build — the probe shape has no user-facing config namespace.

## Known boundaries

- **Fixture green ≠ real-host reading.** `test/probe-shape.mjs` runs against a fake `console`/ctx and proves registration, filtering, ring cap, disposal and the red-line sentinels. It does not prove anything about the running host; those readings come from `GET /dsh-backroom/probe`, and they are the *endpoint* tier, never a screen frame.
- The log tail starts at this plugin's `apply()`. Boot-time lines that happened earlier are only visible if they are still in `logger.buffer` — the probe reports whether that replay channel exists rather than assuming it.
- `console` is wrapped while this plugin is mounted and restored on dispose; a second mount does not stack a second wrapper. Other tools that patch `console` are left alone both ways.
- Process-level facts (`argv`, env names) are reported without values, and anything matching `token` is filtered out of `argv`.
