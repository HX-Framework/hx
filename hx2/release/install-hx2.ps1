#Requires -Version 5.1
# hx2 - laptop daemon for hx-vision
# One-liner install:  irm <this-url> | iex
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$GatewayUrl   = 'http://127.0.0.1:47913/_api/hx-gateway'
$DownloadBase = "$GatewayUrl/download"
$Qs           = '?channel=build'
$InstallDir   = Join-Path $env:USERPROFILE '.let/bin'
$HxDir        = Join-Path $env:USERPROFILE '.let/hx'
$HxExe        = Join-Path $InstallDir 'hx2.exe'

# Refuse old Windows with a message that names the problem.
#
# hx is a Bun-compiled binary, and the Windows loader resolves every static
# import before a single line of our code runs. This build imports ConPTY
# (CreatePseudoConsole, Windows 10 1809) plus WaitOnAddress and CreateFile2
# (Windows 8), so on anything older the process dies with "The procedure entry
# point CreatePseudoConsole could not be located in the dynamic link library
# KERNEL32.dll" — which reads as "this software is broken", not "this computer
# is too old". Nothing on our side can lift that floor: it is the runtime, not
# hx. So say so here, before anything is downloaded.
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 17763) {
  $name = (Get-CimInstance Win32_OperatingSystem).Caption
  Write-Host ''
  Write-Host 'This version of Windows is too old to run hx2.' -ForegroundColor Red
  Write-Host ''
  Write-Host "  Detected: $name (build $build)"
  Write-Host '  Required: Windows 10 version 1809 (build 17763) or newer'
  Write-Host ''
  Write-Host 'Working today on this machine? Install hx2 inside WSL instead, using the'
  Write-Host 'macOS / Linux instructions - that mirrors the sessions inside WSL.'
  Write-Host ''
  exit 1
}

# hx2 ships a native arm64 build beside x64.
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

# The proxy answers the version file with 404 while hx2 has nothing published
# on this channel: say so in one line rather than as a failed download. Any
# other failure falls through to the download, which reports its own.
$releaseStatus = 0
try {
  Invoke-WebRequest -Uri "$DownloadBase/hx2-version$Qs" -UseBasicParsing | Out-Null
} catch {
  try { $releaseStatus = [int]$_.Exception.Response.StatusCode } catch { }
}
if ($releaseStatus -eq 404) {
  Write-Host 'hx2: no hx2 build has been published yet.' -ForegroundColor Red
  # `irm ... | iex` runs this script inside the user's own session, where
  # `exit` would close the window before they could read the line above.
  # $PSCommandPath is empty there and set when the script runs as a file.
  if ($PSCommandPath) { exit 1 } else { return }
}

New-Item -ItemType Directory -Force -Path $InstallDir, $HxDir | Out-Null

# A running hx.exe / hx-svc.exe cannot be overwritten, so stop the daemon before
# replacing anything. Ignore every failure: not-installed and not-running are
# both perfectly normal here.
if (Test-Path $HxExe) {
  Write-Host 'Stopping the running mirror...'
  try { & $HxExe stop 2>&1 | Out-Null } catch { }
}

function Install-HxAsset {
  param([string] $Asset, [string] $Target)

  $tmpGz  = Join-Path $env:TEMP ("$Asset-" + [guid]::NewGuid() + '.gz')
  $tmpBin = Join-Path $env:TEMP ("$Asset-" + [guid]::NewGuid() + '.exe')
  try {
    Invoke-WebRequest -Uri "$DownloadBase/$Asset.gz$Qs" -OutFile $tmpGz -UseBasicParsing

    # No gunzip on Windows - decompress in-process.
    $in  = [System.IO.File]::OpenRead($tmpGz)
    $gz  = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    $out = [System.IO.File]::Create($tmpBin)
    try { $gz.CopyTo($out) } finally { $out.Close(); $gz.Close(); $in.Close() }

    # Verify the DECOMPRESSED bytes, matching install.sh and the runtime
    # contract: the file we exec is the file the sum attests to.
    $shaResp = Invoke-WebRequest -Uri "$DownloadBase/$Asset.sha256$Qs" -UseBasicParsing
    # .Content is a String when the server declares a text content type and a
    # Byte[] when it does not. The proxy sends text/plain today, but the
    # installer does not control that header — and on a Byte[] the split below
    # yields garbage and fails with a "malformed sha256" that names neither the
    # real cause nor the fix. Decode either shape.
    $wantRaw = if ($shaResp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($shaResp.Content) } else { [string]$shaResp.Content }
    $want = ($wantRaw -split '\s+')[0].ToLower()
    $got  = (Get-FileHash -Algorithm SHA256 -Path $tmpBin).Hash.ToLower()
    if ($want -notmatch '^[0-9a-f]{64}$') { throw "malformed sha256 for $Asset" }
    if ($got -ne $want) { throw "checksum mismatch for $Asset (expected $want, got $got)" }

    # Windows refuses to overwrite a mapped image but will rename one, so park
    # anything already there. A parked file that will not delete is still held
    # by a live process; it is harmless and swept by a later run.
    if (Test-Path $Target) {
      $parked = "$Target.old." + [guid]::NewGuid()
      Move-Item -LiteralPath $Target -Destination $parked -Force
      try { Remove-Item -LiteralPath $parked -Force -ErrorAction Stop } catch { }
    }
    Move-Item -LiteralPath $tmpBin -Destination $Target -Force
  } finally {
    Remove-Item -LiteralPath $tmpGz, $tmpBin -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Downloading hx2...'
Install-HxAsset -Asset "hx2-windows-$Arch"     -Target $HxExe
Write-Host 'Downloading the background service build...'
Install-HxAsset -Asset "hx2-windows-$Arch-svc" -Target (Join-Path $InstallDir 'hx2-svc.exe')

# PATH lives in the registry on Windows, so this is durable without touching a
# shell profile - and removable by `hx uninstall` later.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$already = $userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -eq $InstallDir.TrimEnd('\') }
if (-not $already) {
  $joined = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
  Write-Host "Added $InstallDir to your PATH (new terminals only)."
}
# The CURRENT session never inherits the change a child process makes, so patch
# this one too - otherwise the 'hx2 connect' below would not resolve.
if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path = "$env:Path;$InstallDir" }

# Apps & features entry. Cheap, and its absence reads as sketchy software to the
# enterprise audience this is aimed at. `hx uninstall` removes it.
$arp = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\hx2'
New-Item -Path $arp -Force | Out-Null
$hxVersion = (& $HxExe --version) -replace '^hx2 version:\s*', ''
New-ItemProperty -Path $arp -Name 'DisplayName'     -Value 'hx2 (let.ai session mirror)' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $arp -Name 'DisplayVersion'  -Value "$hxVersion"                 -PropertyType String -Force | Out-Null
New-ItemProperty -Path $arp -Name 'Publisher'       -Value 'let.ai'                     -PropertyType String -Force | Out-Null
New-ItemProperty -Path $arp -Name 'DisplayIcon'     -Value $HxExe                       -PropertyType String -Force | Out-Null
New-ItemProperty -Path $arp -Name 'InstallLocation' -Value $InstallDir                  -PropertyType String -Force | Out-Null
New-ItemProperty -Path $arp -Name 'UninstallString' -Value ('"' + $HxExe + '" uninstall') -PropertyType String -Force | Out-Null
New-ItemProperty -Path $arp -Name 'NoModify'        -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $arp -Name 'NoRepair'        -Value 1 -PropertyType DWord -Force | Out-Null

# config.json is hx's single source of truth for where to upload. Three cases,
# identical to install.sh:
#   1. absent          -> seed the gateway this script was served from;
#   2. same gateway    -> leave it alone (keeps the device token);
#   3. other gateway   -> re-point, and drop state.json, whose upload offsets
#      are per-gateway and meaningless against a different one. device-id is
#      deliberately preserved, so reconnecting to the old gateway later restores
#      that device's sessions.
$cfgPath = Join-Path $HxDir 'config.json'
$seed = $false
if (-not (Test-Path $cfgPath)) {
  $seed = $true
} else {
  $savedGw = $null
  try { $savedGw = (Get-Content -Raw $cfgPath | ConvertFrom-Json).gatewayBaseUrl } catch { }
  if ($savedGw -ne $GatewayUrl) {
    $seed = $true
    Remove-Item -LiteralPath (Join-Path $HxDir 'state.json') -Force -ErrorAction SilentlyContinue
  }
}
if ($seed) {
  $cfgJson = [pscustomobject]@{ gatewayBaseUrl = $GatewayUrl } | ConvertTo-Json
  [System.IO.File]::WriteAllText($cfgPath, $cfgJson + [Environment]::NewLine)
}

Write-Host ''
Write-Host 'hx2 installed. Next step:'
Write-Host '    hx2 connect'
