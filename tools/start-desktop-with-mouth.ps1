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
  [Parameter(Mandatory=$true)][string]$Sid,
  [string]$Key = '',
  [string]$Exe = '',
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
if ($Key -eq '') {
  # no key supplied => mint a throwaway one and print it, so nothing is stored anywhere
  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
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
  $env:DSH_BACKROOM_SESSION_ALLOW = $Sid
  Start-Process -FilePath $Exe
  Write-Output ('started. allow=' + $Sid)
}
Write-Output ('use this key for this run: ' + $Key)

$found = $null
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  $found = Find-BackendPort
  if ($found) { Write-Output ('backend port found after ' + ($i + 1) + 's'); break }
}
if (-not $found) { Write-Output 'FAIL: 120s passed and no backend port was recognised (slow start, or the plugin is not in this profile)'; exit 1 }
Write-Output ('backend port = ' + $found)
Write-Output ('probe: curl -s "http://127.0.0.1:' + $found + '/dsh-backroom/probe"')
Write-Output ('mouth: curl -s -X POST "http://127.0.0.1:' + $found + '/dsh-backroom/session?key=' + $Key + '&session=' + $Sid + '&wait=turn-end" -H "content-type: application/json" -d "{\"text\":\"ping\"}"')
