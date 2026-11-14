#!/bin/zsh
set -e

# Restart only Covan's local development process. This intentionally does not
# match other Electron applications running on the machine.
SCRIPT_DIR="${0:A:h}"
VITE_PROCESS="$SCRIPT_DIR/node_modules/.bin/electron-vite dev"
ELECTRON_PROCESS="$SCRIPT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \."

if pgrep -f "$VITE_PROCESS" >/dev/null 2>&1; then
  print "正在关闭已有的 Covan…"
  pkill -TERM -f "$VITE_PROCESS" || true
fi
if pgrep -f "$ELECTRON_PROCESS" >/dev/null 2>&1; then
  pkill -TERM -f "$ELECTRON_PROCESS" || true
fi

# Wait for the profile lock to be released. A stuck old development instance
# must not make the replacement quit or leave two schedulers on one database.
for attempt in {1..50}; do
  if ! pgrep -f "$VITE_PROCESS" >/dev/null 2>&1 && ! pgrep -f "$ELECTRON_PROCESS" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if pgrep -f "$VITE_PROCESS" >/dev/null 2>&1; then
  pkill -KILL -f "$VITE_PROCESS" || true
fi
if pgrep -f "$ELECTRON_PROCESS" >/dev/null 2>&1; then
  pkill -KILL -f "$ELECTRON_PROCESS" || true
fi
exec "$SCRIPT_DIR/start.command"
