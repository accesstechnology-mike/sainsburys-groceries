#!/usr/bin/env bash
# Dev-only. Not used by the CLI or MCP server.
# Launches a real Chrome so a person can record one session, then a small
# CDP listener writes a HAR. The CLI never attaches to this browser.
set -euo pipefail
PORT="${SAINSBURYS_HAR_PORT:-9222}"
PROFILE="${SAINSBURYS_HAR_PROFILE:-${HOME}/.sainsburys/har-profile}"
OUT="${1:-capture.har}"
mkdir -p "$PROFILE"
if ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
  echo "google-chrome is not on PATH. This helper is for a human on a desktop." >&2
  exit 1
fi
CHROME="$(command -v google-chrome || command -v google-chrome-stable)"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --new-window "https://www.sainsburys.co.uk/gol-ui/groceries" \
  >/tmp/sainsburys-har-chrome.log 2>&1 &
echo "Chrome started. Log in, search, add, pick a slot, amend, and check out yourself."
echo "Then save a HAR from DevTools (Network → Export HAR) to ${OUT}."
echo "Sanitise and map it with: bun scripts/import-har.ts ${OUT}"
echo "This process does not read your password and the CLI will not attach to port ${PORT}."
