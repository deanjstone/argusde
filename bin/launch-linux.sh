#!/usr/bin/env bash
# Launches Electron with WSLg's Wayland environment set before exec, since
# Chromium's Ozone platform selection happens during early native init —
# too early for the main process's own JS to influence it (see the comment
# in src/main/index.ts). No-op passthrough everywhere else.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_BIN="$ROOT_DIR/node_modules/.bin/electron"

if [ -d /mnt/wslg ] && { [ -z "${DISPLAY:-}" ] || [ "${DISPLAY}" = ":0" ]; }; then
  export ELECTRON_OZONE_PLATFORM_HINT=wayland
  export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/mnt/wslg/runtime-dir}"
  exec "$ELECTRON_BIN" --no-sandbox "$ROOT_DIR" "$@"
else
  exec "$ELECTRON_BIN" "$ROOT_DIR" "$@"
fi
