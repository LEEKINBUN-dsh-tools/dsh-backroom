# Start the packaged dsh desktop app with the backroom session mouth OPEN for this run only.
# The key is NOT persisted (no setx): it lives in this process's environment and dies with the app.
# Pure ASCII (PITFALLS #102). Params: -Sid (required, comma-separated), -Key (optional, else random per run).
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
$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0 -and -not $NoRestart) {
  Write-Output ('stopping ' + $running.Count + ' existing process(es) so the new env actually applies')
  foreach ($p in $running) { try { Stop-Process -Id $p.Id -Force } catch { } }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (-not (netstat -ano | Select-String ':19387' | Select-String 'LISTENING')) { Write-Output ('port 19387 released after ' + ($i + 1) + 's'); break }
  }
} elseif ($running.Count -gt 0) {
  Write-Output 'NOTE: an instance is already running WITHOUT these env vars; the mouth stays closed there. Drop -NoRestart to restart it.'
}

$env:DSH_BACKROOM_SESSION_KEY = $Key
$env:DSH_BACKROOM_SESSION_ALLOW = $Sid
Start-Process -FilePath $exe
Write-Output ('started. allow=' + $Sid)
Write-Output ('use this key for this run: ' + $Key)
Write-Output ('example: curl -s -X POST "http://127.0.0.1:19387/dsh-backroom/session?key=' + $Key + '&session=' + $Sid + '&wait=turn-end" -H "content-type: application/json" -d "{\"text\":\"ping\"}"')
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  $l = netstat -ano | Select-String ':19387' | Select-String 'LISTENING'
  if ($l) { Write-Output ('19387 LISTENING after ' + ($i + 1) + 's'); exit 0 }
}
Write-Output 'WARN: 19387 did not come back within 90s'
exit 1
