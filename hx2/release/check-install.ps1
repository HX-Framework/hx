# Installs hx2 on Windows the way a person does, `irm … | iex`, from a
# stand-in let.ai on 127.0.0.1 that serves this build (serve.py), checks what
# install-hx2.ps1 left (both binaries, the user PATH, the Apps & features
# entry, config.json), installs again over it, uninstalls and checks that
# nothing of hx2 is left. First, with nothing published, the installer must say
# so, return without closing the window, and install nothing.
#
# Usage: check-install.ps1 -ReleaseDir <dir> -Version <x.y.z> -Work <dir> -Engine powershell|pwsh [-ExpectAsset <name>]
# -Engine is the PowerShell the installer runs in: Windows PowerShell 5.1 or
# PowerShell 7. -ExpectAsset fails the run when the installer, in that
# PowerShell, would pick a different build than the one named. The run happens under <Work>\home, which stands in for
# %USERPROFILE%; the PATH and Apps & features entries are the runner's own
# (HKCU), and the run checks that they end as they began.
param(
  [Parameter(Mandatory)] [string] $ReleaseDir,
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Work,
  [Parameter(Mandatory)] [ValidateSet('powershell', 'pwsh')] [string] $Engine,
  [string] $ExpectAsset = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$port = 47913
$base = "http://127.0.0.1:$port"
$arpKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\hx2'
$py = (Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $py) { throw 'no python on PATH (the workflow sets one up)' }

function Fail([string] $msg) { throw "FAIL: $msg" }
function Pass([string] $msg) { Write-Host "ok: $msg" }
function Same-Path([string] $a, [string] $b) { $a.Replace('/', '\').TrimEnd('\') -eq $b.Replace('/', '\').TrimEnd('\') }

New-Item -ItemType Directory -Force -Path $Work | Out-Null
$log = Join-Path $Work 'requests.log'
$script:server = $null

function Start-StandIn([string[]] $mode) {
  Set-Content -Path $log -Value '' -NoNewline
  $argv = @("$PSScriptRoot\serve.py", '--port', "$port", '--scripts', $PSScriptRoot, '--log', $log) + $mode
  $quoted = $argv | ForEach-Object { '"' + $_ + '"' }
  $script:server = Start-Process -FilePath $py -ArgumentList $quoted -PassThru -NoNewWindow
  $up = $false
  for ($i = 0; $i -lt 100 -and -not $up; $i++) {
    try {
      Invoke-WebRequest "$base/install-hx2.ps1" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $up = $true
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if (-not $up) { Fail 'the stand-in server did not start' }
  Set-Content -Path $log -Value '' -NoNewline
}

function Stop-StandIn {
  if ($script:server) {
    Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue
    $script:server.WaitForExit()
    $script:server = $null
  }
}

# Run the one-liner in a fresh PowerShell, as a person pastes it into a new
# window. 'after-iex' prints only if the script returned instead of exiting.
function Invoke-Installer([string] $name) {
  $out = Join-Path $Work "$Engine-$name.out"
  $cmd = "irm '$base/install-hx2.ps1?channel=build' | iex; 'after-iex'"
  & $Engine -NoProfile -ExecutionPolicy Bypass -Command $cmd *> $out
  $code = $LASTEXITCODE
  $text = Get-Content -Raw $out
  Write-Host $text
  [pscustomobject]@{ Code = $code; Text = [string]$text }
}

function Get-Subsystem([string] $exe) {
  $b = [IO.File]::ReadAllBytes($exe)
  $pe = [BitConverter]::ToInt32($b, 0x3C)
  [BitConverter]::ToUInt16($b, $pe + 0x5C)
}

try {
  # The architecture the installer sees in this engine picks the build.
  $engineArch = (& $Engine -NoProfile -Command '$env:PROCESSOR_ARCHITECTURE' | Out-String).Trim()
  $arch = if ($engineArch -eq 'ARM64') { 'arm64' } else { 'x64' }
  $asset = "hx2-windows-$arch"
  Write-Host "engine: $Engine, PROCESSOR_ARCHITECTURE=$engineArch, expecting $asset"
  if ($ExpectAsset -and $ExpectAsset -ne $asset) { Fail "the installer in $Engine picks $asset here, not $ExpectAsset" }

  $env:USERPROFILE = Join-Path $Work "home-$Engine"
  if (Test-Path $env:USERPROFILE) { Remove-Item -Recurse -Force $env:USERPROFILE }
  New-Item -ItemType Directory -Force -Path $env:USERPROFILE | Out-Null
  $installDir = Join-Path $env:USERPROFILE '.let\bin'
  $hxDir = Join-Path $env:USERPROFILE '.let\hx'
  $hxExe = Join-Path $installDir 'hx2.exe'
  $svcExe = Join-Path $installDir 'hx2-svc.exe'
  $pathBefore = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  if (Test-Path $arpKey) { Fail "an Apps & features entry for hx2 exists before the install" }

  # 1. Nothing published.
  Start-StandIn @('--empty')
  $r = Invoke-Installer 'empty'
  if ($r.Text -notmatch 'hx2: no hx2 build has been published yet\.') { Fail 'the installer did not say that nothing is published' }
  if ($r.Text -notmatch 'after-iex') { Fail 'the installer exited the window instead of returning under iex' }
  if (Test-Path $hxExe) { Fail 'the installer installed something with nothing published' }
  Pass 'nothing published: the installer says so, returns and installs nothing'
  Stop-StandIn

  # 2. Install this build.
  Start-StandIn @('--release', $ReleaseDir)
  $r = Invoke-Installer 'install'
  if ($r.Code -ne 0 -or $r.Text -notmatch 'after-iex') { Fail "the installer failed (exit $($r.Code))" }
  if ($r.Text -notmatch 'hx2 installed\. Next step:') { Fail 'the installer did not report the install' }
  foreach ($exe in @($hxExe, $svcExe)) { if (-not (Test-Path $exe)) { Fail "$exe is missing" } }
  if ((Get-Subsystem $hxExe) -ne 3) { Fail 'hx2.exe is not a console program' }
  if ((Get-Subsystem $svcExe) -ne 2) { Fail 'hx2-svc.exe is not windowless' }
  Pass 'hx2.exe is a console program and hx2-svc.exe is windowless'
  $want = "hx2 version: $Version"
  $got = (& $hxExe --version | Out-String).Trim()
  if ($got -ne $want) { Fail "hx2.exe --version printed '$got'" }
  $gotSvc = (& $svcExe --version | Out-String).Trim()
  if ($gotSvc -ne $want) { Fail "hx2-svc.exe --version printed '$gotSvc'" }
  Pass "hx2 --version: $got (both binaries)"

  $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  Write-Host "user PATH entries: $($entries -join ' | ')"
  if (-not ($entries | Where-Object { Same-Path $_ $installDir })) { Fail "$installDir is not on the user PATH" }
  $fresh = (& powershell -NoProfile -Command '$env:Path = [Environment]::GetEnvironmentVariable(''Path'', ''Machine'') + '';'' + [Environment]::GetEnvironmentVariable(''Path'', ''User''); (Get-Command hx2).Source; hx2 --version' | Out-String).Trim() -split "`r?`n"
  if (-not (Same-Path $fresh[0] $hxExe) -or $fresh[-1] -ne $want) { Fail "a new window does not find this hx2: $($fresh -join ' / ')" }
  Pass 'a new window finds hx2 on the PATH'

  $arp = Get-ItemProperty -Path $arpKey
  if ($arp.DisplayName -ne 'hx2 (let.ai session mirror)') { Fail "DisplayName is '$($arp.DisplayName)'" }
  if ($arp.DisplayVersion -ne $Version) { Fail "DisplayVersion is '$($arp.DisplayVersion)', not '$Version'" }
  if ($arp.Publisher -ne 'let.ai') { Fail "Publisher is '$($arp.Publisher)'" }
  if (-not (Same-Path $arp.InstallLocation $installDir)) { Fail "InstallLocation is '$($arp.InstallLocation)'" }
  if ($arp.UninstallString.Replace('/', '\') -ne ('"' + $hxExe + '" uninstall')) { Fail "UninstallString is '$($arp.UninstallString)'" }
  Pass "Apps & features: $($arp.DisplayName) $($arp.DisplayVersion), $($arp.UninstallString)"

  $cfg = Get-Content -Raw (Join-Path $hxDir 'config.json') | ConvertFrom-Json
  if ($cfg.gatewayBaseUrl -ne "$base/_api/hx-gateway") { Fail "config.json names '$($cfg.gatewayBaseUrl)'" }
  Pass 'config.json names the gateway'
  if (-not (Test-Path (Join-Path $hxDir '.acl-v1'))) { Fail '~/.let/hx was not narrowed to its owner (no .acl-v1)' }
  if (-not (Get-Acl $hxDir).AreAccessRulesProtected) { Fail '~/.let/hx still inherits its parent ACL' }
  Pass '~/.let/hx is narrowed to its owner (hx-home.ts hardenWindowsAcl)'

  $lines = @(Get-Content $log | Where-Object { $_ })
  Write-Host ($lines -join "`n")
  $expected = @(
    'GET /install-hx2.ps1?channel=build 200',
    'GET /_api/hx-gateway/download/hx2-version?channel=build 200',
    "GET /_api/hx-gateway/download/$asset.gz?channel=build 200",
    "GET /_api/hx-gateway/download/$asset.sha256?channel=build 200",
    "GET /_api/hx-gateway/download/$asset-svc.gz?channel=build 200",
    "GET /_api/hx-gateway/download/$asset-svc.sha256?channel=build 200"
  )
  foreach ($e in $expected) { if ($lines -notcontains $e) { Fail "not requested: $e" } }
  if ($lines.Count -ne $expected.Count) { Fail 'the installer made requests beyond the five expected' }
  Pass "the installer fetched hx2-version, $asset and $asset-svc with their checksums on the build channel"

  # 3. Install again over the first install: the running-binary handling,
  # parking the old files, must leave one copy of each.
  $r = Invoke-Installer 'reinstall'
  if ($r.Code -ne 0 -or $r.Text -notmatch 'hx2 installed\. Next step:') { Fail 'installing over an existing install failed' }
  $got = (& $hxExe --version | Out-String).Trim()
  if ($got -ne $want) { Fail "after the second install hx2.exe --version printed '$got'" }
  $parked = @(Get-ChildItem -Path $installDir -Filter '*.old.*' -ErrorAction SilentlyContinue)
  if ($parked.Count -ne 0) { Fail "parked copies left in $installDir" }
  Pass 'installing over an existing install works and leaves no parked copies'
  Stop-StandIn

  # 4. Uninstall. Until hx2 has the command, the check removes what hx
  # uninstall removes on Windows (src/uninstall.ts): both binaries, the Apps &
  # features entry and the PATH entry; ~/.let/hx stays without --purge.
  $out = Join-Path $Work "$Engine-uninstall.out"
  & $hxExe uninstall *> $out
  $code = $LASTEXITCODE
  $text = [string](Get-Content -Raw $out)
  Write-Host $text
  if ($code -eq 64 -and $text -match 'is not available in this build') {
    Write-Host 'hx2 has no uninstall command in this build; removing what hx uninstall removes'
    Remove-Item -LiteralPath $hxExe, $svcExe -Force
    & reg delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\hx2' /f | Out-Null
    $d = Join-Path (Join-Path $env:USERPROFILE '.let') 'bin'
    $ps = "`$d='$($d.Replace("'", "''"))';" +
      "`$p=[Environment]::GetEnvironmentVariable('Path','User');" +
      "if (`$p) { `$n=(`$p -split ';' | Where-Object { `$_ -and `$_.TrimEnd('\') -ne `$d.TrimEnd('\') }) -join ';';" +
      "[Environment]::SetEnvironmentVariable('Path',`$n,'User') }"
    & powershell -NoProfile -NonInteractive -Command $ps
  } elseif ($code -ne 0) {
    Fail "hx2 uninstall exited $code"
  }
  foreach ($exe in @($hxExe, $svcExe)) { if (Test-Path $exe) { Fail "$exe is still there after the uninstall" } }
  if (Test-Path $arpKey) { Fail 'the Apps & features entry is still there after the uninstall' }
  $pathAfter = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  if ($pathAfter -ne $pathBefore) { Fail "the user PATH did not come back: before '$pathBefore', after '$pathAfter'" }
  if (-not (Test-Path (Join-Path $hxDir 'config.json'))) { Fail 'the uninstall removed ~/.let/hx without --purge' }
  Pass 'uninstalled: both binaries, the Apps & features entry and the PATH entry are gone; ~/.let/hx stays'

  # --purge removes ~/.let/hx too; after it no file of hx2's is left.
  Remove-Item -Recurse -Force $hxDir
  $left = @(Get-ChildItem -Path $env:USERPROFILE -Recurse -File -Force -ErrorAction SilentlyContinue)
  if ($left.Count -ne 0) { Fail "files left after the uninstall: $($left.FullName -join ', ')" }
  Pass 'nothing of hx2 is left under the home'
  Write-Host "all install checks passed for $asset $Version in $Engine"
} finally {
  Stop-StandIn
}
