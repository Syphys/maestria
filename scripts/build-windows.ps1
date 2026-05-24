# Maestria Windows build helper.
#
# Default mode produces the full production set (NSIS installer + ZIP
# portable + win-unpacked) via `npm run package-win`. `-Quick` skips
# the installer step and produces only the unpacked exe — useful for
# iterating on a change. `-Reinstall` forces the heavy
# `npm run install-ext-node` step that wipes and reinstalls
# `release/app/node_modules` (needed after a fresh clone, when the
# pro-extensions symlinks are stale, or when you hit ENOENT on
# `@tagspaces/extensions/common/package.json`).
#
# Usage:
#   .\scripts\build-windows.ps1                   # full prod build (NSIS + ZIP + unpacked)
#   .\scripts\build-windows.ps1 -Quick            # just the unpacked exe (faster)
#   .\scripts\build-windows.ps1 -Reinstall        # full prod build + reinstall release/app deps
#   .\scripts\build-windows.ps1 -Quick -Reinstall # combine
#
# Pre-requisites (one-time machine setup, NOT done by this script):
#   - Node 18+, npm
#   - Windows Developer Mode ENABLED — required for electron-builder's
#     winCodeSign cache extraction (otherwise the .7z fails to create
#     darwin/*.dylib symlinks and the build aborts). The script warns
#     if it detects the mode is off but does not toggle it.
#     Toggle manually: Start-Process "ms-settings:developers"

[CmdletBinding()]
param (
    [switch]$Quick,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'

# Always run from the repo root so the relative paths in npm scripts
# resolve regardless of where the user invoked us from.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "==> Maestria Windows build" -ForegroundColor Cyan
Write-Host "    Mode      : $(if ($Quick) { 'quick (unpacked only)' } else { 'production (NSIS + ZIP + unpacked)' })"
Write-Host "    Reinstall : $(if ($Reinstall) { 'yes (release/app/node_modules will be wiped)' } else { 'no' })"
Write-Host "    Repo      : $repoRoot"
Write-Host ""

# ---- 1. Kill any running Maestria.exe ----------------------------------
# electron-builder cleans `D:\PROJETS\builds\win-unpacked\` before
# repackaging; if Maestria is running it holds DLL handles (d3dcompiler_47.dll,
# ffmpeg.dll, …) and the clean fails with `Access is denied`. Killing
# upfront avoids the "tried to be admin, did not help" rabbit hole.
$maestriaProcs = Get-Process Maestria -ErrorAction SilentlyContinue
if ($maestriaProcs) {
    Write-Host "==> Stopping $($maestriaProcs.Count) running Maestria process(es)..." -ForegroundColor Yellow
    $maestriaProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    # Windows releases file handles asynchronously after a process exits;
    # 1-2 s is usually enough but give it a bit of slack.
    Start-Sleep -Seconds 2
}

# ---- 2. Developer Mode check (warn only) -------------------------------
# `AllowDevelopmentWithoutDevLicense = 1` under HKLM means Dev Mode is on.
# We do NOT flip this — modifying HKLM requires admin and the user
# might have it intentionally off. Just warn so they understand the
# winCodeSign symlink errors if the build dies.
$devModeKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$devModeOn = $false
try {
    $value = Get-ItemProperty -Path $devModeKey -Name AllowDevelopmentWithoutDevLicense -ErrorAction Stop
    $devModeOn = ($value.AllowDevelopmentWithoutDevLicense -eq 1)
} catch {
    # Key absent => Dev Mode never enabled on this machine.
    $devModeOn = $false
}
if (-not $devModeOn) {
    Write-Host "==> WARNING: Windows Developer Mode appears to be OFF." -ForegroundColor Yellow
    Write-Host "    electron-builder may fail to extract its winCodeSign cache" -ForegroundColor Yellow
    Write-Host "    (symlink creation in C:\Users\$env:USERNAME\AppData\Local\electron-builder\Cache\)." -ForegroundColor Yellow
    Write-Host "    Enable it with: Start-Process 'ms-settings:developers'" -ForegroundColor Yellow
    Write-Host ""
}

# ---- 3. Optional: full reinstall of release/app/node_modules -----------
# Skipped by default because it takes ~5 min and is usually unnecessary
# between builds. `npm run package-win` runs `install-ext-node`
# internally as its first step anyway, so this is mostly useful with
# -Quick (which goes straight to webpack + electron-builder).
if ($Reinstall) {
    Write-Host "==> npm run install-ext-node" -ForegroundColor Cyan
    npm run install-ext-node
    if ($LASTEXITCODE -ne 0) { throw "install-ext-node failed (exit $LASTEXITCODE)" }
    Write-Host ""
}

# ---- 4. Build --------------------------------------------------------
if ($Quick) {
    # Quick path: just webpack + electron-builder --dir (unpacked exe).
    # Skips the NSIS installer and ZIP packaging => ~5 min faster.
    Write-Host "==> npm run build" -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }

    Write-Host ""
    Write-Host "==> electron-builder --dir (unpacked)" -ForegroundColor Cyan
    npx electron-builder --win --x64 --config resources/builder.json --dir
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
} else {
    # Production path: package-win runs install-ext-node, clean-pro-ext,
    # build, clean-maps, and electron-builder with NSIS + ZIP targets.
    Write-Host "==> npm run package-win" -ForegroundColor Cyan
    npm run package-win
    if ($LASTEXITCODE -ne 0) { throw "npm run package-win failed (exit $LASTEXITCODE)" }
}

# ---- 5. Report -------------------------------------------------------
$buildsDir = Join-Path (Split-Path -Parent $repoRoot) 'builds'
$exe = Join-Path $buildsDir 'win-unpacked\Maestria.exe'
Write-Host ""
Write-Host "==> Build complete" -ForegroundColor Green
if (Test-Path $exe) {
    $sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "    Unpacked  : $exe ($sizeMB MB)"
}
if (-not $Quick) {
    $installer = Get-ChildItem -Path $buildsDir -Filter 'maestria-win-x64-*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*__uninstaller*' } | Select-Object -First 1
    $zip = Get-ChildItem -Path $buildsDir -Filter 'maestria-win-x64-*.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installer) { Write-Host "    Installer : $($installer.FullName) ($([math]::Round($installer.Length / 1MB, 1)) MB)" }
    if ($zip) { Write-Host "    ZIP       : $($zip.FullName) ($([math]::Round($zip.Length / 1MB, 1)) MB)" }
}
Write-Host ""
Write-Host "Launch:   & '$exe'" -ForegroundColor DarkGray
Write-Host "Headless: & '$exe' --headless" -ForegroundColor DarkGray
