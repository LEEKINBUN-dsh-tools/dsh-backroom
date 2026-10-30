# Start the packaged dsh desktop app with the backroom session mouth OPEN for this run only.
# The key is NOT persisted (no setx): it lives in this process's environment and dies with the app.
# Pure ASCII (PITFALLS #102). Params: -Sid (required, comma-separated), -Key (optional, else random per run).
#
# Port rule (10-19, docs/compat/VERSIONS/0.2.1-rc.2/MANIFEST.json P22): since 0.2.1-rc.2 the desktop
# backend does NOT listen on a fixed 19387 any more -- dsh-desktop-host passes "--port 0", so the OS
# assigns a fresh port per boot (measured 12469 and 12750 on one machine). Waiting for 19387 is a
# silent false negative now, so this script discovers the port instead:
#   listening ports owned by the "DeepSeek Harness" PID family, and the backend is the one that
#   answers our cookie-free /dsh-backroom/probe with 200 (fallback: root path answering 401 with the
#   official "dsh web authentication required" sentence).
param(
  # -Sid is OPTIONAL: pass it when you want to prompt an existing session; leave it out when you only
  # need the create route (created sessions are reachable without any allow-list entry).
  [string]$Sid = '',
  [string]$Key = '',
  # Where the one key for this machine lives. Default: %TEMP%\dsh-backroom-key.txt. The launcher writes it
  # (the plugin itself never writes files), so other agents can read the path instead of guessing a value.
  # -Ephemeral mints a throwaway key and does NOT write the file (previous behaviour).
  [string]$KeyFile = '',
  [switch]$Ephemeral,
  [string]$Exe = '',
  # 10-19 gates for the create-session mouth. All optional; unset means that gate stays closed:
  #   -Roots      comma/semicolon-separated directory prefixes a created Session may own (WITHOUT it, POST /sessions is 'disabled')
  #   -Presets    second allow-list of agent-preset ids (the roster itself is read from the official agentPresets.list();
  #               leaving this empty means "anything in the roster that is not broken")
  #   -DenyPresets permission-preset values that must be refused; unset/empty means "display the in-force preset, never block"
  #   -MaxSessions / -Budget  hourly quota and token budget; defaults 3 and 60000 (60000 ~ 4 turns of measured 14,920 tokens/turn)
  [string]$Roots = '',
  [string]$Presets = '',
  [string]$DenyPresets = '',
  [string]$MaxSessions = '',
  [string]$Budget = '',
  [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
if ($Exe -eq '') {
  # Don't hard-code anyone's machine: try the per-user install, then the all-user one.
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $Exe = $c; break } }
  if ($Exe -eq '') { Write-Output 'FAIL: cannot find "DeepSeek Harness.exe"; pass -Exe "<full path>"'; exit 2 }
}
Write-Output ('exe: ' + $Exe)
# 10-30 single-variable measurement: if ELECTRON_RUN_AS_NODE=1 is inherited by this shell (the host app
# injects it into agent shells; it is NOT in HKCU/Machine environment), this exe runs AS NODE:
# bare launch exits 0 with 0 bytes of output and zero processes (looks like a held single-instance lock),
# and `-v` prints a node version. Removing the variable makes the same exe start normally (5-6 processes).
# So the child env must have it scrubbed first. Details: PITFALLS #109.
$scrubbedElectronNode = $false
if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $scrubbedElectronNode = $true
}
if ($scrubbedElectronNode) { Write-Output 'scrubbed ELECTRON_RUN_AS_NODE for this launch (with it, the exe runs as node and exits 0 with no output)' }
# Key resolution (10-19 tail: other agents reported "the two acting routes still answer no-key" - the real
# cause was that the key only existed in this shell). Default behaviour: keep ONE key per machine in a file
# other local agents can read; -Ephemeral keeps the old mint-and-forget behaviour.
if ($KeyFile -eq '') { $KeyFile = Join-Path $env:TEMP 'dsh-backroom-key.txt' }
if ($Ephemeral) {
  if ($Key -eq '') {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  }
  Write-Output ('ephemeral key (not written to disk): ' + $Key)
} else {
  if ($Key -eq '' -and (Test-Path -LiteralPath $KeyFile)) {
    $Key = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
    if ($Key -ne '') { Write-Output ('reusing the key stored at ' + $KeyFile) }
  }
  if ($Key -eq '') {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  }
  Set-Content -LiteralPath $KeyFile -Value $Key -NoNewline -Encoding ascii
  Write-Output ('key file: ' + $KeyFile + '  (other agents should READ this file, not guess the key)')
}

function Get-BackendPorts {
  $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($pids.Count -eq 0) { return @() }
  $ports = @()
  try {
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Select-Object -Unique)
  } catch {
    # NetTCPIP module unavailable: fall back to netstat. Column 1 is the local address, last column is the PID.
    $ports = @(netstat -ano -p TCP | Select-String 'LISTENING' | ForEach-Object {
        $cols = ($_ -replace '\s+', ' ').Trim().Split(' ')
        if ($pids -contains $cols[-1]) {
          $tail = $cols[1]; $j = $tail.LastIndexOf(':')
          if ($j -ge 0) { $tail.Substring($j + 1) }
        }
      } | Where-Object { $_ -ne '' } | Select-Object -Unique)
  }
  return @($ports)
}

function Find-BackendPort {
  foreach ($pt in (Get-BackendPorts)) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $pt + '/dsh-backroom/probe') -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $pt }
    } catch { }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $pt + '/') -TimeoutSec 3 | Out-Null
    } catch {
      if ($_.Exception.Response -and ([int]$_.Exception.Response.StatusCode) -eq 401) { return $pt }
    }
  }
  return $null
}

$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
$startNew = $true
if ($running.Count -gt 0) {
  if ($NoRestart) {
    # Honest about what this branch does NOT do: the running instance keeps whatever env it was started with.
    Write-Output 'NOTE: an instance is already running and -NoRestart was passed, so this script did not touch its env. The key below only works if that instance was started with the same DSH_BACKROOM_SESSION_KEY.'
    $startNew = $false
  } else {
    Write-Output ('stopping ' + $running.Count + ' existing process(es) so the new env actually applies')
    foreach ($p in $running) { try { Stop-Process -Id $p.Id -Force } catch { } }
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      $left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
      if ($left.Count -eq 0) { Write-Output ('all harness processes gone after ' + ($i + 1) + 's'); break }
    }
  }
}
if ($startNew) {
  $env:DSH_BACKROOM_SESSION_KEY = $Key
  if (-not $Ephemeral) { $env:DSH_BACKROOM_KEY_FILE = $KeyFile }
  # No -Sid => no allow-list at all: existing sessions stay unreachable, only sessions this run
  # creates are usable. An unset gate must stay unset (closed), not become an empty "allow".
  if ($Sid -ne '') { $env:DSH_BACKROOM_SESSION_ALLOW = $Sid }
  # Only set what the operator actually named -- an unset gate must stay unset (closed), not "empty = open".
  if ($Roots -ne '') { $env:DSH_BACKROOM_WORKSPACE_ROOTS = $Roots }
  if ($Presets -ne '') { $env:DSH_BACKROOM_ALLOW_PRESETS = $Presets }
  if ($DenyPresets -ne '') { $env:DSH_BACKROOM_DENY_PRESETS = $DenyPresets }
  if ($MaxSessions -ne '') { $env:DSH_BACKROOM_MAX_SESSIONS_PER_HOUR = $MaxSessions }
  if ($Budget -ne '') { $env:DSH_BACKROOM_TOKEN_BUDGET = $Budget }
  Start-Process -FilePath $Exe
  Write-Output ('started. existing sessions reachable: ' + $(if ($Sid -eq '') { 'none (no -Sid given; only sessions this run creates are usable)' } else { $Sid }))
  Write-Output ('gates: roots=' + $(if ($Roots -eq '') { '(unset: POST /sessions stays disabled)' } else { $Roots }) + ' presets=' + $(if ($Presets -eq '') { '(unset: roster decides)' } else { $Presets }) + ' maxSessions=' + $(if ($MaxSessions -eq '') { '(default 3/h)' } else { $MaxSessions }) + ' budget=' + $(if ($Budget -eq '') { '(default 60000 tokens)' } else { $Budget }))
}
Write-Output ('use this key: ' + $Key + $(if ($Ephemeral) { '  (ephemeral: not on disk)' } else { '  (also stored at the key file above; agents may read that file instead)' }))

$found = $null
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  $found = Find-BackendPort
  if ($found) { Write-Output ('backend port found after ' + ($i + 1) + 's'); break }
}
if (-not $found) { Write-Output 'FAIL: 120s passed and no backend port was recognised (slow start, or the plugin is not in this profile)'; exit 1 }
Write-Output ('backend port = ' + $found)
Write-Output ('probe: curl -s "http://127.0.0.1:' + $found + '/dsh-backroom/probe"')
if ($Sid -ne '') {
  Write-Output ('mouth: curl -s -X POST "http://127.0.0.1:' + $found + '/dsh-backroom/session?key=' + $Key + '&session=' + $Sid + '&wait=turn-end" -H "content-type: application/json" -d "{\"text\":\"ping\"}"')
} else {
  Write-Output 'mouth: (no -Sid) create a session first, then POST /dsh-backroom/session with that id'
}
Write-Output ('roster: curl -s "http://127.0.0.1:' + $found + '/dsh-backroom/presets"   (no key needed, read-only)')
if ($Roots -ne '') {
  Write-Output ('create: curl -s -X POST "http://127.0.0.1:' + $found + '/dsh-backroom/sessions?key=' + $Key + '" -H "content-type: application/json" -d "{\"cwd\":\"' + ($Roots -split '[;,]')[0].Trim() + '\",\"caller\":\"launcher\"}"')
}
Write-Output ('ledger: curl -s "http://127.0.0.1:' + $found + '/dsh-backroom/sessions?key=' + $Key + '"   (what this process created, spent, and may still archive)')
