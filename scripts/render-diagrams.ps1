# Maestria diagram renderer.
#
# Renders every `.puml` under `docs/en/` (excluding `_includes/`
# partials) to SVG. The diagram sources are single-source under
# `docs/en/` and i18n-switched via PlantUML `-D` injection — the
# `docs/en/_includes/style.iuml` checks `LANG` and pulls either
# `i18n/strings_en.iuml` (default) or `i18n/strings_fr.iuml`.
#
# Usage:
#   .\scripts\render-diagrams.ps1                # both EN and FR (default)
#   .\scripts\render-diagrams.ps1 -Lang en       # EN only
#   .\scripts\render-diagrams.ps1 -Lang fr       # FR only
#   .\scripts\render-diagrams.ps1 -Lang both     # explicit both
#   .\scripts\render-diagrams.ps1 -JavaPath ...  # override the JDK
#   .\scripts\render-diagrams.ps1 -JarPath  ...  # override the jar
#
# Pre-requisites:
#   - Java 17+ on the PATH (or pointed at via -JavaPath)
#   - `plantuml.jar` at the repo root (or pointed at via -JarPath).
#     Download from https://plantuml.com/download — pin a version
#     locally rather than relying on the network at render time.

[CmdletBinding()]
param (
    [ValidateSet('en', 'fr', 'both')]
    [string]$Lang = 'both',

    [string]$JavaPath = $null,
    [string]$JarPath = $null
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ---- Resolve Java + jar ------------------------------------------------
if (-not $JavaPath) {
    # Prefer a user-pinned path (this is where Android Studio's bundled
    # JBR lives on the project author's machine); fall back to whatever
    # `java` is on PATH otherwise.
    $candidates = @(
        'C:\Program Files\Android\Android Studio\jbr\bin\java.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $JavaPath = $c; break } }
    if (-not $JavaPath) {
        $onPath = (Get-Command java -ErrorAction SilentlyContinue).Source
        if ($onPath) { $JavaPath = $onPath }
    }
}
if (-not $JavaPath -or -not (Test-Path $JavaPath)) {
    throw "Java not found. Install Java 17+ or pass -JavaPath '<path-to-java.exe>'."
}

if (-not $JarPath) { $JarPath = Join-Path $repoRoot 'plantuml.jar' }
if (-not (Test-Path $JarPath)) {
    throw "plantuml.jar not found at $JarPath. Download from https://plantuml.com/download and place it at the repo root, or pass -JarPath."
}

Write-Host "==> Maestria diagram renderer" -ForegroundColor Cyan
Write-Host "    Lang  : $Lang"
Write-Host "    Java  : $JavaPath"
Write-Host "    Jar   : $JarPath"
Write-Host ""

# ---- Enumerate sources ------------------------------------------------
# Single source of truth: docs/en/. Skip _includes/* (partials pulled
# via !include, never rendered standalone). PowerShell's -notlike does
# not honour [] character classes well, so the path filter is wildcard
# based.
$srcDir = Join-Path $repoRoot 'docs\en'
$pumls = Get-ChildItem -Recurse -Path $srcDir -Filter '*.puml' |
    Where-Object { $_.FullName -notlike '*\_includes\*' } |
    ForEach-Object { $_.FullName }

if ($pumls.Count -eq 0) {
    throw "No .puml files found under $srcDir (excluding _includes/)."
}
Write-Host "==> Found $($pumls.Count) renderable .puml files"
Write-Host ""

function Invoke-Render {
    param (
        [string]$LangCode,
        [string]$OutDir
    )
    # Ensure the output directory exists. `-Force` is idempotent
    # whether the dir exists or not.
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

    Write-Host "==> Rendering [$LangCode] -> $OutDir" -ForegroundColor Cyan

    # Bigger heap helps with the larger composers (modelhub package
    # diagram, c4/context). The `-D` flag MUST come AFTER `-jar`, not
    # before — placed before, Java treats it as a JVM system property
    # and PlantUML never sees it (diagnosed 2026-05-25).
    $args = @('-jar', $JarPath)
    if ($LangCode -ne 'en') {
        # `en` is the default in style.iuml when LANG is undefined, so
        # we save the flag for non-EN passes. Adding -DLANG=en works
        # too but is redundant.
        $args += "-DLANG=$LangCode"
    }
    $args += @('-tsvg', '-o', $OutDir)
    $args += $pumls

    $proc = Start-Process -FilePath $JavaPath -ArgumentList $args -NoNewWindow -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "PlantUML failed for lang=$LangCode (exit $($proc.ExitCode))"
    }

    $svgCount = (Get-ChildItem $OutDir -Filter '*.svg').Count
    Write-Host "    -> $svgCount SVGs"
    Write-Host ""
}

# ---- Render -----------------------------------------------------------
if ($Lang -eq 'en' -or $Lang -eq 'both') {
    Invoke-Render -LangCode 'en' -OutDir (Join-Path $repoRoot 'docs\en\svg')
}
if ($Lang -eq 'fr' -or $Lang -eq 'both') {
    Invoke-Render -LangCode 'fr' -OutDir (Join-Path $repoRoot 'docs\fr\svg')
}

Write-Host "==> Done" -ForegroundColor Green
