#Requires -Version 5.1
# hx — build from source and connect, the Windows counterpart of
# ./install-from-source.sh.
#
#   git clone https://github.com/hx-framework/hx; cd hx
#   .\install-from-source.ps1 [https://<your-workbench>/_api/hx-gateway]
#
# Same destination as the one-line installer, compiling locally instead of
# downloading: build both binaries, install to ~/.let/bin, put that on PATH,
# seed the gateway into ~/.let/hx/config.json, then hand off to `hx connect`.
param([string] $GatewayUrl = 'https://let.ai/_api/hx-gateway')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:USERPROFILE '.let/bin'
$HxDir      = Join-Path $env:USERPROFILE '.let/hx'
$HxExe      = Join-Path $InstallDir 'hx.exe'

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error 'bun is required to build from source. Install it from https://bun.sh and re-run.'
}

New-Item -ItemType Directory -Force -Path $InstallDir, $HxDir | Out-Null

Write-Host 'Installing dependencies...'
bun install --frozen-lockfile

Write-Host 'Building the web UI...'
Push-Location ui
try { bun install --frozen-lockfile; bun run build } finally { Pop-Location }
bun run gen:ui

# Two binaries: hx.exe is a console app because the CLI needs a console to print
# to; hx-svc.exe is windowless so the scheduled task doesn't park a console
# window on the desktop at every logon. --windows-hide-console only works when
# compiling ON Windows, which is exactly where this script runs.
New-Item -ItemType Directory -Force -Path dist | Out-Null
Write-Host 'Compiling hx.exe...'
bun build --compile --minify ./src/cli.ts --outfile dist/hx.exe
Write-Host 'Compiling hx-svc.exe...'
bun build --compile --minify --windows-hide-console ./src/cli.ts --outfile dist/hx-svc.exe

# A running .exe cannot be overwritten, only renamed — so stop the mirror first
# and park anything still held.
if (Test-Path $HxExe) {
  try { & $HxExe stop 2>&1 | Out-Null } catch { }
}
foreach ($name in 'hx.exe', 'hx-svc.exe') {
  $target = Join-Path $InstallDir $name
  if (Test-Path $target) {
    $parked = "$target.old." + [guid]::NewGuid()
    Move-Item -LiteralPath $target -Destination $parked -Force
    try { Remove-Item -LiteralPath $parked -Force -ErrorAction Stop } catch { }
  }
  Move-Item -LiteralPath (Join-Path 'dist' $name) -Destination $target -Force
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (-not ($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -eq $InstallDir.TrimEnd('\') })) {
  $joined = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
  Write-Host "Added $InstallDir to your PATH (new terminals only)."
}
if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path = "$env:Path;$InstallDir" }

# config.json is hx's single source of truth for where to upload.
$cfgPath = Join-Path $HxDir 'config.json'
$seed = $true
if (Test-Path $cfgPath) {
  $savedGw = $null
  try { $savedGw = (Get-Content -Raw $cfgPath | ConvertFrom-Json).gatewayBaseUrl } catch { }
  if ($savedGw -eq $GatewayUrl) {
    $seed = $false
  } else {
    # Per-gateway upload offsets mean nothing against a different gateway.
    # device-id is preserved so reconnecting to the old one restores its sessions.
    Remove-Item -LiteralPath (Join-Path $HxDir 'state.json') -Force -ErrorAction SilentlyContinue
  }
}
if ($seed) {
  $cfgJson = [pscustomobject]@{ gatewayBaseUrl = $GatewayUrl } | ConvertTo-Json
  [System.IO.File]::WriteAllText($cfgPath, $cfgJson + [Environment]::NewLine)
}

Write-Host ''
Write-Host 'Built and installed. Connecting this device...'
& $HxExe connect
