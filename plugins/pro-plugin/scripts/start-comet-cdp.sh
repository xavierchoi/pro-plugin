#!/usr/bin/env bash
set -euo pipefail

PORT="${CHATGPT_PRO_CDP_PORT:-9222}"
PROFILE_DIR="${CHATGPT_PRO_COMET_PROFILE:-$HOME/.cache/codex-chatgpt-pro-comet-profile}"
COMET_APP="${COMET_APP:-/Applications/Comet.app}"
COMET_BIN="${COMET_BIN:-$COMET_APP/Contents/MacOS/Comet}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check the CDP endpoint." >&2
  exit 1
fi

if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "CDP endpoint already responding at http://127.0.0.1:$PORT"
  exit 0
fi

if [[ ! -x "$COMET_BIN" ]]; then
  echo "Comet executable not found at: $COMET_BIN" >&2
  echo "Set COMET_BIN=/path/to/Comet or install Comet in /Applications." >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "Starting Comet with CDP on http://127.0.0.1:$PORT"
echo "Profile: $PROFILE_DIR"

"$COMET_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  "https://chatgpt.com/" >/tmp/pro-plugin-comet.log 2>&1 &

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "Comet CDP is ready at http://127.0.0.1:$PORT"
    echo "Complete ChatGPT login and 2FA in the Comet window, then run chatgpt_pro_status."
    exit 0
  fi
  sleep 0.25
done

echo "Comet started, but CDP did not respond within 10 seconds." >&2
echo "Check /tmp/pro-plugin-comet.log for browser startup output." >&2
exit 1
