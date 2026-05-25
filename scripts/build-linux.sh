#!/usr/bin/env bash
# Maestria Linux build helper.
#
# Default mode produces the full production set (AppImage + deb + tar.gz)
# via `npm run package-linux`. `--quick` skips electron-builder packaging
# and produces only the unpacked dir — useful for iterating on a change.
# `--reinstall` forces the heavy `npm run install-ext-node` step that
# wipes and reinstalls `release/app/node_modules` (needed after a fresh
# clone, when the pro-extensions symlinks are stale, or when you hit
# ENOENT on `@tagspaces/extensions/common/package.json`).
#
# Usage:
#   ./scripts/build-linux.sh                       # full prod build (AppImage + deb + tar.gz)
#   ./scripts/build-linux.sh --quick               # just the unpacked dir (faster)
#   ./scripts/build-linux.sh --reinstall           # full prod build + reinstall release/app deps
#   ./scripts/build-linux.sh --quick --reinstall   # combine
#
# Pre-requisites (one-time machine setup, NOT done by this script):
#   - Node 18+, npm
#   - llama.cpp providing `llama-server` on PATH (Arch: paru -S llama.cpp-hip)
#   - FUSE (for running the resulting AppImage; not for building it)

set -euo pipefail

QUICK=0
REINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --quick|-q) QUICK=1 ;;
    --reinstall|-r) REINSTALL=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Always run from the repo root so the relative paths in npm scripts
# resolve regardless of where the user invoked us from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# Colors (skip if not a tty)
if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_YELLOW=$'\033[33m'; C_GREEN=$'\033[32m'; C_GRAY=$'\033[90m'; C_RESET=$'\033[0m'
else
  C_CYAN=''; C_YELLOW=''; C_GREEN=''; C_GRAY=''; C_RESET=''
fi

echo "${C_CYAN}==> Maestria Linux build${C_RESET}"
if [ "$QUICK" -eq 1 ]; then echo "    Mode      : quick (unpacked only)"; else echo "    Mode      : production (AppImage + deb + tar.gz)"; fi
if [ "$REINSTALL" -eq 1 ]; then echo "    Reinstall : yes (release/app/node_modules will be wiped)"; else echo "    Reinstall : no"; fi
echo "    Repo      : $REPO_ROOT"
echo ""

# ---- 1. Strip Electron env vars that break dev/build under VS Code -----
# `ELECTRON_RUN_AS_NODE=1` makes Electron behave like Node and crashes
# with EBADF when launched in a GUI context. The Claude Code VS Code
# extension sets this for its own bundled Node; it leaks into child
# shells. Unset before invoking electron-builder.
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE

# ---- 2. Kill any running Maestria process ------------------------------
# electron-builder cleans `../builds/linux-unpacked/` before repackaging;
# if Maestria is running it holds .so handles and the clean fails.
if pgrep -x maestria > /dev/null 2>&1 || pgrep -x Maestria > /dev/null 2>&1; then
  echo "${C_YELLOW}==> Stopping running Maestria process(es)...${C_RESET}"
  pkill -x maestria 2>/dev/null || true
  pkill -x Maestria 2>/dev/null || true
  sleep 1
fi

# ---- 3. Optional: full reinstall of release/app/node_modules -----------
# Skipped by default because `npm install` retries 25-40 min on the
# private @tagspacespro/* GitHub registry (returns 401 for AGPL fork
# users without credentials). Default flow assumes node_modules are
# already present from a prior install. Pass --reinstall to force.
if [ "$REINSTALL" -eq 1 ]; then
  echo "${C_CYAN}==> npm run install-ext-node${C_RESET}"
  npm run install-ext-node
  echo ""
elif [ ! -d "$REPO_ROOT/release/app/node_modules" ]; then
  echo "${C_YELLOW}==> release/app/node_modules missing → running install-ext-node (may take 25+ min on first run due to @tagspacespro 401 retries)${C_RESET}"
  npm run install-ext-node
  echo ""
fi

# ---- 3b. Symlink fix for build:main -----------------------------------
# `@tagspaces/tagspaces-common-node` is only declared in
# release/app/package.json (it's a main-process dep) but webpack
# build:main resolves modules from the root node_modules/. The
# postinstall hook normally creates this symlink via link-modules.ts,
# but a partial install can leave it missing. Recreate idempotently.
COMMON_NODE_LINK="$REPO_ROOT/node_modules/@tagspaces/tagspaces-common-node"
COMMON_NODE_SRC="$REPO_ROOT/release/app/node_modules/@tagspaces/tagspaces-common-node"
if [ ! -e "$COMMON_NODE_LINK" ] && [ -e "$COMMON_NODE_SRC" ]; then
  echo "${C_CYAN}==> linking @tagspaces/tagspaces-common-node into root node_modules${C_RESET}"
  mkdir -p "$REPO_ROOT/node_modules/@tagspaces"
  ln -sf "$COMMON_NODE_SRC" "$COMMON_NODE_LINK"
fi

# ---- 4. Build --------------------------------------------------------
if [ "$QUICK" -eq 1 ]; then
  # Quick path: just webpack + electron-builder --dir (unpacked).
  # Skips AppImage/deb/tar.gz packaging => much faster.
  echo "${C_CYAN}==> npm run clean-pro-ext + generate-extensions${C_RESET}"
  npm run clean-pro-ext
  npm run generate-extensions

  echo "${C_CYAN}==> npm run build${C_RESET}"
  npm run build

  echo ""
  echo "${C_CYAN}==> electron-builder --dir (unpacked)${C_RESET}"
  npx electron-builder --linux --x64 --config resources/builder.json --dir
else
  # Production path: full pipeline minus install-ext-node (handled above).
  echo "${C_CYAN}==> clean-pro-ext + generate-extensions + clean${C_RESET}"
  npm run clean-pro-ext
  npm run generate-extensions
  npx ts-node ./.erb/scripts/clean.js

  echo "${C_CYAN}==> npm run build${C_RESET}"
  npm run build

  echo "${C_CYAN}==> npm run clean-maps${C_RESET}"
  npm run clean-maps

  echo "${C_CYAN}==> electron-builder --linux${C_RESET}"
  npx electron-builder --linux --config resources/builder.json
fi

# ---- 5. chrome-sandbox SUID --------------------------------------------
# Chromium's setuid sandbox requires the binary to be owned by root with
# mode 4755. electron-builder bundles it but does not apply the SUID bit
# (the build user typically isn't root). Apply it in the unpacked dir so
# the dev workflow works; the .deb / .AppImage handle this themselves
# at install/run time.
UNPACKED_SANDBOX="$(cd "$REPO_ROOT/.." && pwd)/builds/linux-unpacked/chrome-sandbox"
if [ -f "$UNPACKED_SANDBOX" ]; then
  if [ "$(stat -c '%u %a' "$UNPACKED_SANDBOX")" != "0 4755" ]; then
    echo ""
    echo "${C_YELLOW}==> Applying SUID to chrome-sandbox (requires sudo)${C_RESET}"
    sudo chown root:root "$UNPACKED_SANDBOX"
    sudo chmod 4755 "$UNPACKED_SANDBOX"
  fi
fi

# ---- 6. Report -------------------------------------------------------
# Normalize ../builds path so the report shows /run/media/.../builds rather
# than /run/media/.../tagspaces/../builds.
BUILDS_DIR="$(cd "$REPO_ROOT/.." && pwd)/builds"
echo ""
echo "${C_GREEN}==> Build complete${C_RESET}"

UNPACKED="$BUILDS_DIR/linux-unpacked/maestria"
if [ -f "$UNPACKED" ]; then
  size_mb=$(du -m "$UNPACKED" | cut -f1)
  echo "    Unpacked  : $UNPACKED (${size_mb} MB)"
fi

if [ "$QUICK" -eq 0 ]; then
  # electron-builder names files with both `x64` (tar.gz/deb x86-64) and
  # `x86_64` (AppImage) — match either, plus arm64 variants.
  APPIMAGE=$(ls -1 "$BUILDS_DIR"/maestria-linux-x86_64-*.AppImage 2>/dev/null | head -1 || true)
  DEB=$(ls -1 "$BUILDS_DIR"/maestria-linux-amd64-*.deb 2>/dev/null | head -1 || true)
  TGZ=$(ls -1 "$BUILDS_DIR"/maestria-linux-x64-*.tar.gz 2>/dev/null | head -1 || true)
  DEB_ARM=$(ls -1 "$BUILDS_DIR"/maestria-linux-arm64-*.deb 2>/dev/null | head -1 || true)
  TGZ_ARM=$(ls -1 "$BUILDS_DIR"/maestria-linux-arm64-*.tar.gz 2>/dev/null | head -1 || true)
  [ -n "$APPIMAGE" ] && echo "    AppImage      : $APPIMAGE ($(du -m "$APPIMAGE" | cut -f1) MB)"
  [ -n "$DEB" ]      && echo "    .deb x64      : $DEB ($(du -m "$DEB" | cut -f1) MB)"
  [ -n "$DEB_ARM" ]  && echo "    .deb arm64    : $DEB_ARM ($(du -m "$DEB_ARM" | cut -f1) MB)"
  [ -n "$TGZ" ]      && echo "    tar.gz x64    : $TGZ ($(du -m "$TGZ" | cut -f1) MB)"
  [ -n "$TGZ_ARM" ]  && echo "    tar.gz arm64  : $TGZ_ARM ($(du -m "$TGZ_ARM" | cut -f1) MB)"
fi

echo ""
if [ -n "${APPIMAGE:-}" ]; then
  echo "${C_GRAY}Launch:   chmod +x '$APPIMAGE' && '$APPIMAGE'${C_RESET}"
  echo "${C_GRAY}Headless: MAESTRIA_HEADLESS=1 '$APPIMAGE'${C_RESET}"
elif [ -f "$UNPACKED" ]; then
  echo "${C_GRAY}Launch:   '$UNPACKED'${C_RESET}"
  echo "${C_GRAY}Headless: MAESTRIA_HEADLESS=1 '$UNPACKED'${C_RESET}"
fi
