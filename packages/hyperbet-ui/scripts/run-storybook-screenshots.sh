#!/usr/bin/env bash
set -euo pipefail

STORYBOOK_PORT="${STORYBOOK_SCREENSHOT_PORT:-6006}"
if ! [[ "$STORYBOOK_PORT" =~ ^[0-9]+$ ]] || (( 10#$STORYBOOK_PORT < 1 || 10#$STORYBOOK_PORT > 65535 )); then
  echo "invalid STORYBOOK_SCREENSHOT_PORT: $STORYBOOK_PORT" >&2
  exit 1
fi

python3 -m http.server "$STORYBOOK_PORT" -d storybook-static --bind 127.0.0.1 >/tmp/hyperbet-ui-storybook-http.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}

trap cleanup EXIT

sleep 0.1
SERVER_READY=false
for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    cat /tmp/hyperbet-ui-storybook-http.log >&2
    exit 1
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:$STORYBOOK_PORT/index.json" >/dev/null 2>&1; then
    SERVER_READY=true
    break
  fi
  sleep 0.25
done

if [[ "$SERVER_READY" != true ]]; then
  echo "storybook screenshot server did not become ready on port $STORYBOOK_PORT" >&2
  cat /tmp/hyperbet-ui-storybook-http.log >&2
  exit 1
fi

STORYBOOK_SCREENSHOT_BASE_URL="http://127.0.0.1:$STORYBOOK_PORT" \
  node ./scripts/capture-storybook-screenshots.mjs
