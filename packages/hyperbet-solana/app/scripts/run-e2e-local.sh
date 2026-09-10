#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$(cd "$APP_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/../.." && pwd)"
ANCHOR_DIR="$DEMO_DIR/anchor"
KEEPER_DIR="$DEMO_DIR/keeper"
resolve_node_22_bin() {
  local candidate=""
  local version=""
  local major=""
  local -a candidates=()

  if [[ -n "${E2E_NODE_BIN:-}" ]]; then
    candidates+=("${E2E_NODE_BIN}")
  fi
  if [[ -n "${NODE_BIN:-}" ]]; then
    candidates+=("${NODE_BIN}")
  fi
  candidates+=(
    "$REPO_ROOT/../.toolchains/node-v22.23.2/node-v22.23.2-darwin-arm64/bin/node"
    "/opt/homebrew/opt/node@22/bin/node"
  )
  for candidate in "$HOME"/.nvm/versions/node/v22*/bin/node; do
    candidates+=("$candidate")
  done
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=("/usr/local/bin/node" "/opt/homebrew/bin/node")

  for candidate in "${candidates[@]}"; do
    if [[ ! -x "$candidate" ]]; then
      continue
    fi
    version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
    major="${version%%.*}"
    if [[ "$major" == "22" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

E2E_NODE_BIN="$(resolve_node_22_bin 2>/dev/null || true)"
if [[ -z "$E2E_NODE_BIN" ]]; then
  echo "[e2e] Node 22.x is required; set E2E_NODE_BIN to an approved Node 22 binary" >&2
  exit 1
fi
export PATH="$(dirname "$E2E_NODE_BIN"):$PATH"
SOLANA_ACTIVE_RELEASE_BIN="${SOLANA_ACTIVE_RELEASE_BIN:-$HOME/.local/share/solana/install/active_release/bin}"
if [[ -d "$SOLANA_ACTIVE_RELEASE_BIN" ]]; then
  export PATH="$SOLANA_ACTIVE_RELEASE_BIN:$PATH"
fi
E2E_OWNS_CARGO_TARGET=0
CARGO_TARGET_DIR="${E2E_CARGO_TARGET_DIR:-}"
ANCHOR_BUILD_LOG="/tmp/hyperbet-solana-e2e-build.log"
STATE_PATH="$APP_DIR/tests/e2e/state.json"
CONTROL_PATH="$APP_DIR/tests/e2e/control.json"
VALIDATOR_LOG="$APP_DIR/.e2e-validator.log"
APP_LOG="$APP_DIR/.e2e-app.log"
SOLANA_PROXY_LOG="$APP_DIR/.e2e-solana-proxy.log"
KEEPER_LOG="$APP_DIR/.e2e-keeper.log"
DUEL_BOT_LOG="$APP_DIR/.e2e-duel-bot.log"
BET_SYNC_FEED_LOG="$APP_DIR/.e2e-bet-sync-feed.log"
HLS_LOG="$APP_DIR/.e2e-hls.log"
HLS_BACKUP_LOG="$APP_DIR/.e2e-hls-backup.log"
HLS_PRIMARY_ORIGIN_LOG="$APP_DIR/.e2e-hls-primary-origin.log"
HLS_BACKUP_ORIGIN_LOG="$APP_DIR/.e2e-hls-backup-origin.log"
APP_PID_FILE="$APP_DIR/.e2e-app.pid"
VALIDATOR_PID_FILE="$APP_DIR/.e2e-validator.pid"
SOLANA_PROXY_PID_FILE="$APP_DIR/.e2e-solana-proxy.pid"
KEEPER_PID_FILE="$APP_DIR/.e2e-keeper.pid"
DUEL_BOT_PID_FILE="$APP_DIR/.e2e-duel-bot.pid"
BET_SYNC_FEED_PID_FILE="$APP_DIR/.e2e-bet-sync-feed.pid"
HLS_PID_FILE="$APP_DIR/.e2e-hls.pid"
HLS_BACKUP_PID_FILE="$APP_DIR/.e2e-hls-backup.pid"
HLS_PRIMARY_ORIGIN_PID_FILE="$APP_DIR/.e2e-hls-primary-origin.pid"
HLS_BACKUP_ORIGIN_PID_FILE="$APP_DIR/.e2e-hls-backup-origin.pid"
HLS_PRIMARY_ORIGIN_ENV_FILE="$APP_DIR/.e2e-hls-primary-origin.env"
HLS_BACKUP_ORIGIN_ENV_FILE="$APP_DIR/.e2e-hls-backup-origin.env"
HYPERIA_PID_FILE="$APP_DIR/.e2e-hyperia.pid"
HYPERIA_LOG="$APP_DIR/.e2e-hyperia.log"
HYPERIA_ENV_FILE="$APP_DIR/.e2e-hyperia.env"
HYPERIA_PREPARATION_EVIDENCE_FILE="$APP_DIR/.e2e-hyperia-preparation-evidence.json"
HYPERIA_PREPARATION_FRAME_FILE="$APP_DIR/.e2e-hyperia-preparation-frame.png"
HYPERIA_PREPARATION_AGENT1_FRAME_FILE="$APP_DIR/.e2e-hyperia-preparation-agent1-frame.png"
HYPERIA_PREPARATION_AGENT2_FRAME_FILE="$APP_DIR/.e2e-hyperia-preparation-agent2-frame.png"
HYPERIA_CAPTURE_FRAME_REQUEST_FILE="$APP_DIR/.e2e-hyperia-capture-frame-request.json"
HYPERIA_CAPTURE_FRAME_STATUS_FILE="$APP_DIR/.e2e-hyperia-capture-frame-status.json"
HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE="$APP_DIR/.e2e-hyperia-ordinary-preparation-evidence.json"
SOLANA_PROXY_ENV_FILE="$APP_DIR/.e2e-solana-proxy.env"
SOLANA_PROXY_FAULT_CONTROL_PATH="$APP_DIR/.e2e-solana-rpc-fault.json"
KEEPER_ENV_FILE="$APP_DIR/.e2e-keeper.env"
DUEL_BOT_ENV_FILE="$APP_DIR/.e2e-duel-bot.env"
PROGRAM_ORACLE_ID="FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu"
PROGRAM_DUEL_MARKET_ID="7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG"
APP_PORT="${E2E_APP_PORT:-4181}"
GAME_API_PORT="${E2E_GAME_API_PORT:-5555}"
GAME_API_URL="http://127.0.0.1:${GAME_API_PORT}"
BET_SYNC_FEED_PORT="${E2E_BET_SYNC_FEED_PORT:-$((GAME_API_PORT + 1))}"
BET_SYNC_FEED_URL="http://127.0.0.1:${BET_SYNC_FEED_PORT}"
PW_HEADLESS="${PW_HEADLESS:-1}"
PW_WEBGPU_ARGS="${PW_WEBGPU_ARGS:---enable-unsafe-webgpu}"
if [[ "$(uname -s)" == "Darwin" && -z "${PW_BROWSER_CHANNEL:-}" ]]; then
  PW_BROWSER_CHANNEL="chrome"
fi
export PW_HEADLESS PW_WEBGPU_ARGS PW_BROWSER_CHANNEL
KEEPER_DB_PATH="${E2E_KEEPER_DB_PATH:-$APP_DIR/.e2e-keeper.sqlite}"
KEEPER_STATUS_DIR="$KEEPER_DIR/.status"
KEEPER_BOT_HEALTH_PATH="$KEEPER_STATUS_DIR/keeper-bot-health.json"
KEEPER_STREAM_STATE_PATH="$KEEPER_STATUS_DIR/stream-state.json"
SOLANA_RPC_PORT="${E2E_SOLANA_RPC_PORT:-18899}"
# solana-test-validator exposes websocket on rpc-port + 1; keep the harness
# aligned with that invariant so alternate RPC ports stay portable.
SOLANA_WS_PORT="$((SOLANA_RPC_PORT + 1))"
SOLANA_FAUCET_PORT="${E2E_SOLANA_FAUCET_PORT:-18901}"
SOLANA_GOSSIP_PORT="${E2E_SOLANA_GOSSIP_PORT:-18902}"
SOLANA_DYNAMIC_PORT_START="${E2E_SOLANA_DYNAMIC_PORT_START:-$((SOLANA_RPC_PORT + 100))}"
SOLANA_DYNAMIC_PORT_END="${E2E_SOLANA_DYNAMIC_PORT_END:-$((SOLANA_DYNAMIC_PORT_START + 99))}"
LEDGER_DIR="${E2E_SOLANA_LEDGER_DIR:-$APP_DIR/.e2e-ledger-${SOLANA_RPC_PORT}}"
SOLANA_RPC_URL="http://127.0.0.1:${SOLANA_RPC_PORT}"
SOLANA_WS_URL="ws://127.0.0.1:${SOLANA_WS_PORT}"
SOLANA_PROXY_PORT="${E2E_SOLANA_PROXY_PORT:-$((20000 + RANDOM % 10000))}"
SOLANA_PROXY_URL="http://127.0.0.1:${SOLANA_PROXY_PORT}"
SOLANA_PROXY_WS_URL="ws://127.0.0.1:${SOLANA_PROXY_PORT}"
SOLANA_VERIFIER_PROXY_URL="${SOLANA_PROXY_URL}/verifier"
E2E_ARENA_WRITE_KEY="${E2E_ARENA_WRITE_KEY:-hyperbet-e2e-local-write-key}"
E2E_DUEL_SOURCE="${E2E_DUEL_SOURCE:-synthetic_publish}"
E2E_HYPERIA_RUNTIME="${E2E_HYPERIA_RUNTIME:-compact}"
E2E_HYPERIA_TERMINAL_EXPECTATION="${E2E_HYPERIA_TERMINAL_EXPECTATION:-natural_kill}"
E2E_HYPERIA_COMBAT_ROLE="${E2E_HYPERIA_COMBAT_ROLE:-ranged}"
HYPERIA_MULTI_STYLE="${AGENT_DUEL_3D_E2E_MULTI_STYLE:-false}"
E2E_APP_RUNTIME="${E2E_APP_RUNTIME:-development}"
E2E_PRODUCTION_TRANSACTIONS="${E2E_PRODUCTION_TRANSACTIONS:-false}"
E2E_WAGER_AUTHORITY_MATRIX="${E2E_WAGER_AUTHORITY_MATRIX:-false}"
E2E_CAPTURE_WAGER_AUTHORITY_MATRIX="${E2E_CAPTURE_WAGER_AUTHORITY_MATRIX:-false}"
E2E_BROWSER_AUDIT_HOLD_SECONDS="${E2E_BROWSER_AUDIT_HOLD_SECONDS:-0}"
E2E_PERFORMANCE_PROFILE="${E2E_PERFORMANCE_PROFILE:-desktop_720p}"
E2E_HLS_ADAPTIVE="${E2E_HLS_ADAPTIVE:-false}"
E2E_HLS_FAILOVER="${E2E_HLS_FAILOVER:-false}"
HLS_PRIMARY_ORIGIN_PORT="${E2E_HLS_PRIMARY_ORIGIN_PORT:-}"
HLS_BACKUP_ORIGIN_PORT="${E2E_HLS_BACKUP_ORIGIN_PORT:-}"
case "$E2E_DUEL_SOURCE" in
  synthetic_publish|real_hyperia) ;;
  *)
    echo "[e2e] E2E_DUEL_SOURCE must be synthetic_publish or real_hyperia" >&2
    exit 1
    ;;
esac
case "$E2E_HYPERIA_RUNTIME" in
  compact|full_3d) ;;
  *)
    echo "[e2e] E2E_HYPERIA_RUNTIME must be compact or full_3d" >&2
    exit 1
    ;;
esac
case "$E2E_HYPERIA_TERMINAL_EXPECTATION" in
  natural_kill|short_kill|exact_timeout) ;;
  *)
    echo "[e2e] E2E_HYPERIA_TERMINAL_EXPECTATION must be natural_kill, short_kill, or exact_timeout" >&2
    exit 1
    ;;
esac
case "$E2E_HYPERIA_COMBAT_ROLE" in
  melee|ranged|mage) ;;
  *)
    echo "[e2e] E2E_HYPERIA_COMBAT_ROLE must be melee, ranged, or mage" >&2
    exit 1
    ;;
esac
case "$HYPERIA_MULTI_STYLE" in
  true|false) ;;
  *)
    echo "[e2e] AGENT_DUEL_3D_E2E_MULTI_STYLE must be true or false" >&2
    exit 1
    ;;
esac
if [[ "$HYPERIA_MULTI_STYLE" == "true" && ( "$E2E_HYPERIA_RUNTIME" != "full_3d" || "$E2E_HYPERIA_COMBAT_ROLE" != "ranged" ) ]]; then
  echo "[e2e] AGENT_DUEL_3D_E2E_MULTI_STYLE=true requires full_3d with the ranged fixture" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && "$E2E_DUEL_SOURCE" != "real_hyperia" ]]; then
  echo "[e2e] E2E_HYPERIA_RUNTIME=full_3d requires E2E_DUEL_SOURCE=real_hyperia" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_TERMINAL_EXPECTATION" == "exact_timeout" && ( "$E2E_HYPERIA_RUNTIME" != "full_3d" || "$E2E_DUEL_SOURCE" != "real_hyperia" ) ]]; then
  echo "[e2e] exact_timeout requires the real_hyperia full_3d runtime" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_TERMINAL_EXPECTATION" == "short_kill" && ( "$E2E_HYPERIA_RUNTIME" != "full_3d" || "$E2E_DUEL_SOURCE" != "real_hyperia" || "$E2E_HYPERIA_COMBAT_ROLE" != "ranged" || "$HYPERIA_MULTI_STYLE" != "false" ) ]]; then
  echo "[e2e] short_kill requires the real_hyperia full_3d runtime with the fixed ranged fixture" >&2
  exit 1
fi
case "$E2E_APP_RUNTIME" in
  development|production_preview) ;;
  *)
    echo "[e2e] E2E_APP_RUNTIME must be development or production_preview" >&2
    exit 1
    ;;
esac
case "$E2E_PRODUCTION_TRANSACTIONS" in
  true|false) ;;
  *)
    echo "[e2e] E2E_PRODUCTION_TRANSACTIONS must be true or false" >&2
    exit 1
    ;;
esac
if [[ "$E2E_PRODUCTION_TRANSACTIONS" == "true" && "$E2E_APP_RUNTIME" != "production_preview" ]]; then
  echo "[e2e] E2E_PRODUCTION_TRANSACTIONS=true requires E2E_APP_RUNTIME=production_preview" >&2
  exit 1
fi
export E2E_APP_RUNTIME E2E_PRODUCTION_TRANSACTIONS
case "$E2E_WAGER_AUTHORITY_MATRIX" in
  true|false) ;;
  *) echo "[e2e] E2E_WAGER_AUTHORITY_MATRIX must be true or false" >&2; exit 1 ;;
esac
if [[ "$E2E_WAGER_AUTHORITY_MATRIX" == "true" && ( "$E2E_APP_RUNTIME" != "production_preview" || "$E2E_PRODUCTION_TRANSACTIONS" != "true" || "$E2E_DUEL_SOURCE" != "synthetic_publish" ) ]]; then
  echo "[e2e] wager authority matrix requires production_preview, explicit local transactions, and synthetic_publish" >&2
  exit 1
fi
case "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" in
  true|false) ;;
  *) echo "[e2e] E2E_CAPTURE_WAGER_AUTHORITY_MATRIX must be true or false" >&2; exit 1 ;;
esac
if [[ "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" == "true" && ( "$E2E_APP_RUNTIME" != "production_preview" || "$E2E_PRODUCTION_TRANSACTIONS" != "true" || "$E2E_DUEL_SOURCE" != "real_hyperia" || "$E2E_HYPERIA_RUNTIME" != "full_3d" || "$E2E_WAGER_AUTHORITY_MATRIX" == "true" ) ]]; then
  echo "[e2e] capture wager authority matrix requires production_preview, explicit local transactions, and real_hyperia full_3d; synthetic matrix must be off" >&2
  exit 1
fi
if [[ ! "$E2E_BROWSER_AUDIT_HOLD_SECONDS" =~ ^[0-9]+$ ]] || (( E2E_BROWSER_AUDIT_HOLD_SECONDS > 900 )); then
  echo "[e2e] E2E_BROWSER_AUDIT_HOLD_SECONDS must be an integer from 0 to 900" >&2
  exit 1
fi
if (( E2E_BROWSER_AUDIT_HOLD_SECONDS > 0 )) && [[ "${CI:-false}" == "true" || "${GITHUB_ACTIONS:-false}" == "true" ]]; then
  echo "[e2e] E2E_BROWSER_AUDIT_HOLD_SECONDS is forbidden in CI" >&2
  exit 1
fi
case "$E2E_HLS_ADAPTIVE" in
  true|false) ;;
  *)
    echo "[e2e] E2E_HLS_ADAPTIVE must be true or false" >&2
    exit 1
    ;;
esac
case "$E2E_HLS_FAILOVER" in
  true|false) ;;
  *)
    echo "[e2e] E2E_HLS_FAILOVER must be true or false" >&2
    exit 1
    ;;
esac
if [[ "$E2E_HLS_FAILOVER" == "true" && "$E2E_HLS_ADAPTIVE" != "true" ]]; then
  echo "[e2e] E2E_HLS_FAILOVER requires E2E_HLS_ADAPTIVE=true" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && ( "$E2E_HLS_ADAPTIVE" == "true" || "$E2E_HLS_FAILOVER" == "true" ) ]]; then
  echo "[e2e] the full_3d Hyperia source currently requires the canonical single-rendition HLS lane" >&2
  exit 1
fi
HLS_PLAYLIST_FILE="stream.m3u8"
if [[ "$E2E_HLS_ADAPTIVE" == "true" ]]; then
  HLS_PLAYLIST_FILE="master.m3u8"
fi
HLS_VIDEO_WIDTH=640
HLS_VIDEO_HEIGHT=360
HLS_VIDEO_BITRATE_KBPS=1200
HLS_VIDEO_MAXRATE_KBPS=1320
HLS_VIDEO_BUFSIZE_KBPS=2400
HLS_AUDIO_BITRATE_KBPS=96
if [[ "$E2E_APP_RUNTIME" == "production_preview" ]]; then
  case "$E2E_PERFORMANCE_PROFILE" in
    desktop_720p)
      HLS_VIDEO_WIDTH=1280
      HLS_VIDEO_HEIGHT=720
      HLS_VIDEO_BITRATE_KBPS=4500
      HLS_VIDEO_MAXRATE_KBPS=4950
      HLS_VIDEO_BUFSIZE_KBPS=9000
      HLS_AUDIO_BITRATE_KBPS=128
      ;;
    mobile_360p)
      HLS_VIDEO_WIDTH=640
      HLS_VIDEO_HEIGHT=360
      HLS_VIDEO_BITRATE_KBPS=900
      HLS_VIDEO_MAXRATE_KBPS=1000
      HLS_VIDEO_BUFSIZE_KBPS=1800
      HLS_AUDIO_BITRATE_KBPS=128
      ;;
    *)
      echo "[e2e] E2E_PERFORMANCE_PROFILE must be desktop_720p or mobile_360p for production_preview" >&2
      exit 1
      ;;
  esac
fi
HYPERIA_ROOT="${E2E_HYPERIA_ROOT:-$REPO_ROOT/../hyperia-implementation}"
HYPERIA_API_PORT="${E2E_HYPERIA_API_PORT:-15555}"
HYPERIA_WS_PORT="${E2E_HYPERIA_WS_PORT:-$((HYPERIA_API_PORT + 1))}"
HYPERIA_CLIENT_PORT="${E2E_HYPERIA_CLIENT_PORT:-$((HYPERIA_API_PORT + 2))}"
HYPERIA_RTMP_PORT="${E2E_HYPERIA_RTMP_PORT:-$((HYPERIA_API_PORT + 3))}"
HYPERIA_CAPTURE_BROWSER_PORT="${E2E_HYPERIA_CAPTURE_BROWSER_PORT:-$((HYPERIA_API_PORT + 4))}"
HYPERIA_SPECTATOR_PORT="${E2E_HYPERIA_SPECTATOR_PORT:-$((HYPERIA_API_PORT + 5))}"
HYPERIA_URL="http://127.0.0.1:${HYPERIA_API_PORT}"
HYPERIA_BET_SYNC_STATE_URL="$HYPERIA_URL/api/internal/bet-sync/state"
HYPERIA_AUTHORITY_HEALTH_URL="$HYPERIA_URL/health"
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
  HYPERIA_AUTHORITY_HEALTH_URL="$HYPERIA_URL/api/internal/bet-sync/authority-health"
fi
HYPERIA_BET_SYNC_TOKEN="${E2E_HYPERIA_BET_SYNC_TOKEN:-hyperia-sol-e2e-bet-sync-token-authority}"
HYPERIA_POSTGRES_CONTAINER="hyperia-sol-e2e-${SOLANA_RPC_PORT}-$$"
HYPERIA_POSTGRES_USER="hyperia_sol_e2e"
HYPERIA_POSTGRES_PASSWORD="hyperia-sol-e2e-password"
HYPERIA_POSTGRES_DB="hyperia_sol_e2e"
HYPERIA_ADMIN_CODE="${E2E_HYPERIA_ADMIN_CODE:-hyperia-sol-e2e-admin-code-authority}"
HYPERIA_BUN_PATH="${E2E_HYPERIA_BUN_PATH:-$HYPERIA_ROOT/../.toolchains/bun-v1.3.14/bun-darwin-aarch64/bun}"
HYPERIA_RENDERER_STATUS_FILE=""
HYPERIA_CAPTURE_STATUS_FILE=""
HYPERIA_STARTUP_WAIT_SECONDS="90"
DEFAULT_HYPERIA_PREPARATION_MS="60000"
DEFAULT_HYPERIA_PUBLIC_PREPARATION_MIN_MS="0"
DEFAULT_HYPERIA_ANNOUNCEMENT_MS="1800000"
DEFAULT_REAL_HYPERIA_MIN_OPEN_WINDOW_MS="600000"
DEFAULT_HYPERIA_RESOLUTION_MS="10000"
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
  HYPERIA_STARTUP_WAIT_SECONDS="600"
  DEFAULT_HYPERIA_PREPARATION_MS="600000"
  DEFAULT_HYPERIA_PUBLIC_PREPARATION_MIN_MS="45000"
  DEFAULT_HYPERIA_ANNOUNCEMENT_MS="240000"
  DEFAULT_REAL_HYPERIA_MIN_OPEN_WINDOW_MS="60000"
  DEFAULT_HYPERIA_RESOLUTION_MS="30000"
fi
HYPERIA_PREPARATION_MS="${E2E_HYPERIA_PREPARATION_MS:-$DEFAULT_HYPERIA_PREPARATION_MS}"
HYPERIA_PUBLIC_PREPARATION_MIN_MS="${E2E_HYPERIA_PUBLIC_PREPARATION_MIN_MS:-$DEFAULT_HYPERIA_PUBLIC_PREPARATION_MIN_MS}"
HYPERIA_ANNOUNCEMENT_MS="${E2E_HYPERIA_ANNOUNCEMENT_MS:-$DEFAULT_HYPERIA_ANNOUNCEMENT_MS}"
HYPERIA_RESOLUTION_MS="${E2E_HYPERIA_RESOLUTION_MS:-$DEFAULT_HYPERIA_RESOLUTION_MS}"
REAL_HYPERIA_MIN_OPEN_WINDOW_MS="${E2E_REAL_HYPERIA_MIN_OPEN_WINDOW_MS:-$DEFAULT_REAL_HYPERIA_MIN_OPEN_WINDOW_MS}"
HYPERIA_NATURAL_TERMINAL="${E2E_HYPERIA_NATURAL_TERMINAL:-false}"
if [[ "$HYPERIA_NATURAL_TERMINAL" != "true" && "$HYPERIA_NATURAL_TERMINAL" != "false" ]]; then
  echo "[e2e] E2E_HYPERIA_NATURAL_TERMINAL must be true or false" >&2
  exit 1
fi
if [[ "$HYPERIA_NATURAL_TERMINAL" == "true" && "$E2E_DUEL_SOURCE" != "real_hyperia" ]]; then
  echo "[e2e] E2E_HYPERIA_NATURAL_TERMINAL requires E2E_DUEL_SOURCE=real_hyperia" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && "$HYPERIA_NATURAL_TERMINAL" != "true" ]]; then
  echo "[e2e] E2E_HYPERIA_RUNTIME=full_3d requires E2E_HYPERIA_NATURAL_TERMINAL=true" >&2
  exit 1
fi
HYPERIA_ORDINARY_PREPARATION="${E2E_HYPERIA_ORDINARY_PREPARATION:-$HYPERIA_NATURAL_TERMINAL}"
if [[ "$HYPERIA_ORDINARY_PREPARATION" != "true" && "$HYPERIA_ORDINARY_PREPARATION" != "false" ]]; then
  echo "[e2e] E2E_HYPERIA_ORDINARY_PREPARATION must be true or false" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && "$HYPERIA_ORDINARY_PREPARATION" != "true" ]]; then
  echo "[e2e] E2E_HYPERIA_RUNTIME=full_3d requires E2E_HYPERIA_ORDINARY_PREPARATION=true" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && ! -x "$HYPERIA_BUN_PATH" ]]; then
  echo "[e2e] full_3d Hyperia runtime requires an executable pinned Bun at $HYPERIA_BUN_PATH" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
  if (( ${#HYPERIA_BET_SYNC_TOKEN} < 32 )); then
    echo "[e2e] full_3d Hyperia betting-feed token must contain at least 32 bytes" >&2
    exit 1
  fi
  if (( ${#HYPERIA_ADMIN_CODE} < 32 )); then
    echo "[e2e] full_3d Hyperia admin token must contain at least 32 bytes" >&2
    exit 1
  fi
fi
for hyperia_port_name in \
  HYPERIA_API_PORT \
  HYPERIA_WS_PORT \
  HYPERIA_CLIENT_PORT \
  HYPERIA_RTMP_PORT \
  HYPERIA_CAPTURE_BROWSER_PORT \
  HYPERIA_SPECTATOR_PORT; do
  hyperia_port_value="${!hyperia_port_name}"
  if [[ ! "$hyperia_port_value" =~ ^[1-9][0-9]*$ ]] || (( hyperia_port_value > 65535 )); then
    echo "[e2e] ${hyperia_port_name} must be an integer from 1 to 65535" >&2
    exit 1
  fi
done
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
  hyperia_port_count="$(printf '%s\n' \
    "$HYPERIA_API_PORT" \
    "$HYPERIA_WS_PORT" \
    "$HYPERIA_CLIENT_PORT" \
    "$HYPERIA_RTMP_PORT" \
    "$HYPERIA_CAPTURE_BROWSER_PORT" \
    "$HYPERIA_SPECTATOR_PORT" | sort -u | wc -l | tr -d ' ')"
  if [[ "$hyperia_port_count" != "6" ]]; then
    echo "[e2e] full_3d Hyperia service ports must be distinct" >&2
    exit 1
  fi
fi
for duration_name in HYPERIA_PREPARATION_MS HYPERIA_ANNOUNCEMENT_MS HYPERIA_RESOLUTION_MS REAL_HYPERIA_MIN_OPEN_WINDOW_MS; do
  duration_value="${!duration_name}"
  if [[ ! "$duration_value" =~ ^[1-9][0-9]*$ ]]; then
    echo "[e2e] ${duration_name} must be a positive integer" >&2
    exit 1
  fi
done
if [[ ! "$HYPERIA_PUBLIC_PREPARATION_MIN_MS" =~ ^[0-9]+$ ]]; then
  echo "[e2e] E2E_HYPERIA_PUBLIC_PREPARATION_MIN_MS must be a non-negative integer" >&2
  exit 1
fi
if (( HYPERIA_PUBLIC_PREPARATION_MIN_MS >= HYPERIA_PREPARATION_MS )); then
  echo "[e2e] E2E_HYPERIA_PUBLIC_PREPARATION_MIN_MS must be below E2E_HYPERIA_PREPARATION_MS" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]] && \
  (( HYPERIA_PREPARATION_MS < HYPERIA_STARTUP_WAIT_SECONDS * 1000 )); then
  echo "[e2e] full_3d preparation authority must cover the complete bounded startup readiness envelope" >&2
  exit 1
fi
if (( HYPERIA_ANNOUNCEMENT_MS < 60000 )); then
  echo "[e2e] E2E_HYPERIA_ANNOUNCEMENT_MS must be at least 60000" >&2
  exit 1
fi
if (( HYPERIA_RESOLUTION_MS < 10000 )); then
  echo "[e2e] E2E_HYPERIA_RESOLUTION_MS must be at least 10000" >&2
  exit 1
fi
if (( REAL_HYPERIA_MIN_OPEN_WINDOW_MS < 60000 )); then
  echo "[e2e] E2E_REAL_HYPERIA_MIN_OPEN_WINDOW_MS must be at least 60000" >&2
  exit 1
fi
if (( REAL_HYPERIA_MIN_OPEN_WINDOW_MS >= HYPERIA_ANNOUNCEMENT_MS )); then
  echo "[e2e] E2E_REAL_HYPERIA_MIN_OPEN_WINDOW_MS must be below E2E_HYPERIA_ANNOUNCEMENT_MS" >&2
  exit 1
fi
E2E_ORACLE_DISPUTE_WINDOW_SECS="${E2E_SOLANA_ORACLE_DISPUTE_WINDOW_SECS:-60}"
if [[ ! "$E2E_ORACLE_DISPUTE_WINDOW_SECS" =~ ^[1-9][0-9]*$ ]] || (( E2E_ORACLE_DISPUTE_WINDOW_SECS < 60 )); then
  echo "[e2e] E2E_SOLANA_ORACLE_DISPUTE_WINDOW_SECS must be an integer >= 60" >&2
  exit 1
fi
if [[ "$E2E_DUEL_SOURCE" == "real_hyperia" && ! -f "$HYPERIA_ROOT/packages/server/scripts/run-agent-duel-bet-sync-service.ts" ]]; then
  echo "[e2e] modern Hyperia SOL betting source is missing at $HYPERIA_ROOT" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && ! -f "$HYPERIA_ROOT/packages/server/scripts/seed-agent-duel-3d-e2e.ts" ]]; then
  echo "[e2e] full_3d Hyperia seed source is missing at $HYPERIA_ROOT" >&2
  exit 1
fi
if [[ "$E2E_HYPERIA_TERMINAL_EXPECTATION" == "short_kill" && ! -f "$HYPERIA_ROOT/packages/server/scripts/configure-agent-duel-3d-short-kill-e2e.ts" ]]; then
  echo "[e2e] short-kill combat profile authority is missing at $HYPERIA_ROOT" >&2
  exit 1
fi
if [[ "$HYPERIA_ORDINARY_PREPARATION" == "true" && ! -f "$HYPERIA_ROOT/packages/server/scripts/test-agent-preparation-to-duel-combined.ts" ]]; then
  echo "[e2e] ordinary preparation authority is missing at $HYPERIA_ROOT" >&2
  exit 1
fi

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

find_available_loopback_port() {
  "$E2E_NODE_BIN" -e '
    const net = require("node:net");
    const server = net.createServer();
    server.unref();
    server.on("error", (error) => {
      console.error(error.message);
      process.exit(1);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") process.exit(1);
      console.log(address.port);
      server.close();
    });
  '
}

validate_loopback_port() {
  local label="$1"
  local port_number="$2"
  if [[ ! "$port_number" =~ ^[1-9][0-9]*$ ]] || (( port_number > 65535 )); then
    echo "[e2e] $label must be an integer from 1 to 65535" >&2
    exit 1
  fi
}

for required_solana_command in solana-keygen solana-test-validator; do
  if ! has_cmd "$required_solana_command"; then
    echo "[e2e] missing $required_solana_command; set SOLANA_ACTIVE_RELEASE_BIN to the pinned Solana CLI bin directory" >&2
    exit 1
  fi
done

for required_media_command in ffmpeg ffprobe; do
  if ! has_cmd "$required_media_command"; then
    echo "[e2e] $required_media_command is required on PATH before starting verified HLS tests" >&2
    exit 1
  fi
done

resolve_vite_bin() {
  local candidate
  for candidate in \
    "$APP_DIR/node_modules/.bin/vite" \
    "$DEMO_DIR/node_modules/.bin/vite" \
    "$REPO_ROOT/node_modules/.bin/vite"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "[e2e] unable to resolve Vite from app, package, or workspace node_modules" >&2
  return 1
}

grep_q() {
  local pattern="$1"
  if has_cmd rg; then
    rg -q "$pattern"
  else
    grep -q "$pattern"
  fi
}
resolve_localnet_wallet_path() {
  local candidates=()

  if [[ "$E2E_WAGER_AUTHORITY_MATRIX" == "true" || "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" == "true" ]]; then
    if [[ "${E2E_SOLANA_BOOTSTRAP_KEYPAIR:-}" != /* || ! -f "${E2E_SOLANA_BOOTSTRAP_KEYPAIR:-}" ]]; then
      echo "[e2e] authority verification requires an explicit existing absolute E2E_SOLANA_BOOTSTRAP_KEYPAIR; configured wallet fallback is forbidden" >&2
      return 1
    fi
    printf '%s\n' "$E2E_SOLANA_BOOTSTRAP_KEYPAIR"
    return 0
  fi

  if [[ -n "${E2E_SOLANA_BOOTSTRAP_KEYPAIR:-}" ]]; then
    candidates+=("${E2E_SOLANA_BOOTSTRAP_KEYPAIR}")
  fi
  candidates+=(
    "$HOME/.config/solana/hyperia-keys/deployer.json"
    "$HOME/.config/solana/id.json"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf 'No local E2E bootstrap wallet found. Checked:\n' >&2
  printf '  %s\n' "${candidates[@]}" >&2
  exit 1
}

resolve_localnet_mint_authority() {
  local wallet_path="$1"

  if [[ -n "${E2E_SOLANA_MINT_AUTHORITY:-}" ]]; then
    printf '%s\n' "${E2E_SOLANA_MINT_AUTHORITY}"
    return 0
  fi

  solana-keygen pubkey "$wallet_path"
}

BOOTSTRAP_WALLET_PATH="$(resolve_localnet_wallet_path)"
SOLANA_MINT_AUTHORITY="$(resolve_localnet_mint_authority "$BOOTSTRAP_WALLET_PATH")"
VITE_BIN="$(resolve_vite_bin)"

write_pid_file() {
  local pid_file="$1"
  local pid="$2"
  printf '%s\n' "$pid" >"$pid_file"
}

kill_pid_file_process() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    # A process restarted through e2e-process-control.sh is no longer a child
    # of this shell, so `wait` returns immediately even while its graceful
    # shutdown is still flushing state. Do not tear down dependencies such as
    # Postgres until every owned process has actually exited.
    wait "$pid" >/dev/null 2>&1 || true
    for _ in {1..300}; do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.1
    done
  fi
}

write_env_file() {
  local env_file="$1"
  shift
  : >"$env_file"
  while (( "$#" )); do
    local key="$1"
    local value="$2"
    shift 2
    printf '%s=%q\n' "$key" "$value" >>"$env_file"
  done
}

write_control_file() {
  local hyperia_cwd="$HYPERIA_ROOT/packages/server"
  local hyperia_start_command="exec bun run service:agent-duel-bet-sync-e2e"
  if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
    hyperia_cwd="$HYPERIA_ROOT"
    hyperia_start_command="exec \"$E2E_NODE_BIN\" scripts/duel-stack.mjs --server-url \"$HYPERIA_URL\" --ws-url \"ws://127.0.0.1:$HYPERIA_WS_PORT/ws\" --client-url \"http://127.0.0.1:$HYPERIA_CLIENT_PORT\" --rtmp-port \"$HYPERIA_RTMP_PORT\" --capture-browser-port \"$HYPERIA_CAPTURE_BROWSER_PORT\" --skip-bots --skip-betting --skip-keeper --local-smoke --isolated"
    if [[ "${E2E_SKIP_PREBUILD:-false}" == "true" ]]; then
      hyperia_start_command+=" --reuse-game-builds"
    fi
  fi
  jq -n \
    --arg appDir "$APP_DIR" \
    --arg launchPath "$PATH" \
    --arg chainKey "solana" \
    --arg statePath "$STATE_PATH" \
    --arg controlPath "$CONTROL_PATH" \
    --arg appPidFile "$APP_PID_FILE" \
    --arg appUrl "http://127.0.0.1:${APP_PORT}/" \
    --arg keeperPidFile "$KEEPER_PID_FILE" \
    --arg keeperLog "$KEEPER_LOG" \
    --arg keeperEnv "$KEEPER_ENV_FILE" \
    --arg keeperCwd "$KEEPER_DIR" \
    --arg keeperHealthUrl "$GAME_API_URL/status" \
    --arg keeperBotHealthUrl "$GAME_API_URL/api/keeper/bot-health" \
    --arg duelBotPidFile "$DUEL_BOT_PID_FILE" \
    --arg duelBotLog "$DUEL_BOT_LOG" \
    --arg duelBotEnv "$DUEL_BOT_ENV_FILE" \
    --arg hlsPidFile "$HLS_PID_FILE" \
    --arg hlsLog "$HLS_LOG" \
    --arg hlsPlaylistUrl "$HLS_PRIMARY_URL" \
    --arg hlsPrimaryOriginPidFile "$HLS_PRIMARY_ORIGIN_PID_FILE" \
    --arg hlsPrimaryOriginLog "$HLS_PRIMARY_ORIGIN_LOG" \
    --arg hlsPrimaryOriginEnv "$HLS_PRIMARY_ORIGIN_ENV_FILE" \
    --arg hlsPrimaryOriginUrl "$HLS_PRIMARY_URL" \
    --arg hlsBackupOriginPidFile "$HLS_BACKUP_ORIGIN_PID_FILE" \
    --arg hlsBackupOriginLog "$HLS_BACKUP_ORIGIN_LOG" \
    --arg hlsBackupOriginEnv "$HLS_BACKUP_ORIGIN_ENV_FILE" \
    --arg hlsBackupOriginUrl "$HLS_BACKUP_URL" \
    --arg solanaProxyPidFile "$SOLANA_PROXY_PID_FILE" \
    --arg solanaProxyLog "$SOLANA_PROXY_LOG" \
    --arg solanaProxyEnv "$SOLANA_PROXY_ENV_FILE" \
    --arg solanaProxyFaultControlPath "$SOLANA_PROXY_FAULT_CONTROL_PATH" \
    --arg solanaProxyRpcUrl "$SOLANA_PROXY_URL" \
    --arg validatorPidFile "$VALIDATOR_PID_FILE" \
    --arg validatorLog "$VALIDATOR_LOG" \
    --arg solanaRpcUrl "$SOLANA_RPC_URL" \
    --arg solanaWsUrl "$SOLANA_WS_URL" \
    --arg duelSource "$E2E_DUEL_SOURCE" \
    --arg hyperiaRuntime "$E2E_HYPERIA_RUNTIME" \
    --arg hyperiaCombatRole "$E2E_HYPERIA_COMBAT_ROLE" \
    --arg hyperiaPidFile "$HYPERIA_PID_FILE" \
    --arg hyperiaLog "$HYPERIA_LOG" \
    --arg hyperiaEnv "$HYPERIA_ENV_FILE" \
    --arg hyperiaCwd "$hyperia_cwd" \
    --arg hyperiaHealthUrl "$HYPERIA_URL/health" \
    --arg hyperiaAuthorityHealthUrl "$HYPERIA_AUTHORITY_HEALTH_URL" \
    --arg hyperiaStreamStateUrl "$HYPERIA_URL/api/streaming/state" \
    --arg hyperiaRendererStatusFile "$HYPERIA_RENDERER_STATUS_FILE" \
    --arg hyperiaCaptureStatusFile "$HYPERIA_CAPTURE_STATUS_FILE" \
    --argjson hyperiaCapturePort "$HYPERIA_RTMP_PORT" \
    --argjson hyperiaCaptureBrowserPort "$HYPERIA_CAPTURE_BROWSER_PORT" \
    --arg hyperiaPreparationEvidenceFile "$HYPERIA_PREPARATION_EVIDENCE_FILE" \
    --arg hyperiaPreparationFrameFile "$HYPERIA_PREPARATION_FRAME_FILE" \
    --arg hyperiaTerminalExpectation "$E2E_HYPERIA_TERMINAL_EXPECTATION" \
    --arg hyperiaStartCommand "$hyperia_start_command" \
    '{
      version: 1,
      chainKey: $chainKey,
      appDir: $appDir,
      launchPath: $launchPath,
      statePath: $statePath,
      controlPath: $controlPath,
      rpc: {
        solanaRpcUrl: $solanaRpcUrl,
        solanaWsUrl: $solanaWsUrl
      },
      services: ({
        app: {
          pidFile: $appPidFile,
          url: $appUrl
        },
        keeper: {
          pidFile: $keeperPidFile,
          logPath: $keeperLog,
          envFile: $keeperEnv,
          cwd: $keeperCwd,
          healthUrl: $keeperHealthUrl,
          botHealthUrl: $keeperBotHealthUrl
        },
        keeperBot: {
          pidFile: $duelBotPidFile,
          logPath: $duelBotLog,
          envFile: $duelBotEnv,
          cwd: $keeperCwd,
          healthUrl: $keeperBotHealthUrl,
          startCommand: "bun run duel-bot",
          restartSignal: "SIGKILL"
        },
        hls: {
          pidFile: $hlsPidFile,
          logPath: $hlsLog,
          playlistUrl: $hlsPlaylistUrl
        },
        hlsPrimaryOrigin: {
          pidFile: $hlsPrimaryOriginPidFile,
          logPath: $hlsPrimaryOriginLog,
          envFile: $hlsPrimaryOriginEnv,
          cwd: $appDir,
          healthUrl: $hlsPrimaryOriginUrl,
          startCommand: "exec node scripts/e2e-hls-origin.mjs --label \"$HLS_ORIGIN_LABEL\" --port \"$HLS_ORIGIN_PORT\" --root \"$HLS_ORIGIN_ROOT\"",
          restartSignal: "SIGKILL"
        },
        hlsBackupOrigin: {
          pidFile: $hlsBackupOriginPidFile,
          logPath: $hlsBackupOriginLog,
          envFile: $hlsBackupOriginEnv,
          cwd: $appDir,
          healthUrl: $hlsBackupOriginUrl,
          startCommand: "exec node scripts/e2e-hls-origin.mjs --label \"$HLS_ORIGIN_LABEL\" --port \"$HLS_ORIGIN_PORT\" --root \"$HLS_ORIGIN_ROOT\"",
          restartSignal: "SIGKILL"
        },
        solanaProxy: {
          pidFile: $solanaProxyPidFile,
          logPath: $solanaProxyLog,
          envFile: $solanaProxyEnv,
          rpcUrl: $solanaProxyRpcUrl,
          faultControlPath: $solanaProxyFaultControlPath
        },
        validator: {
          pidFile: $validatorPidFile,
          logPath: $validatorLog,
          rpcUrl: $solanaRpcUrl
        }
      } + (if $duelSource == "real_hyperia" then {
        hyperia: {
          pidFile: $hyperiaPidFile,
          logPath: $hyperiaLog,
          envFile: $hyperiaEnv,
          cwd: $hyperiaCwd,
          healthUrl: $hyperiaHealthUrl,
          authorityHealthUrl: $hyperiaAuthorityHealthUrl,
          streamStateUrl: $hyperiaStreamStateUrl,
          runtime: $hyperiaRuntime,
          combatRole: $hyperiaCombatRole,
          terminalExpectation: $hyperiaTerminalExpectation,
          rendererStatusPath: (if $hyperiaRendererStatusFile == "" then null else $hyperiaRendererStatusFile end),
          captureStatusPath: (if $hyperiaCaptureStatusFile == "" then null else $hyperiaCaptureStatusFile end),
          capturePort: $hyperiaCapturePort,
          captureBrowserPort: $hyperiaCaptureBrowserPort,
          preparationEvidencePath: (if $hyperiaRuntime == "full_3d" then $hyperiaPreparationEvidenceFile else null end),
          preparationFramePath: (if $hyperiaRuntime == "full_3d" then $hyperiaPreparationFrameFile else null end),
          startCommand: $hyperiaStartCommand,
          pidStrategy: (if $hyperiaRuntime == "full_3d" then "root" else "listener" end),
          restartSignal: "SIGKILL"
        }
      } else {} end))
    }' >"$CONTROL_PATH"
}

VALIDATOR_PID=""
APP_PID=""
SOLANA_PROXY_PID=""
KEEPER_PID=""
DUEL_BOT_PID=""
BET_SYNC_FEED_PID=""
HLS_PID=""
HLS_BACKUP_PID=""
HLS_PRIMARY_ORIGIN_PID=""
HLS_BACKUP_ORIGIN_PID=""
HYPERIA_PID=""
HLS_ROOT=""
HLS_PRIMARY_URL=""
HLS_BACKUP_URL=""
HLS_CONTENT_PARITY_PATH=""

cleanup_hls_root() {
  if [[ -z "$HLS_ROOT" || ! -d "$HLS_ROOT" ]]; then
    return 0
  fi
  case "$(basename "$HLS_ROOT")" in
    hyperbet-solana-e2e-hls.*)
      rm -rf -- "$HLS_ROOT"
      ;;
    *)
      echo "[e2e] refusing to remove unexpected HLS temp path: $HLS_ROOT" >&2
      ;;
  esac
}

cleanup_cargo_target() {
  if [[ "$E2E_OWNS_CARGO_TARGET" != "1" || ! -d "$CARGO_TARGET_DIR" ]]; then
    return 0
  fi
  case "$(basename "$CARGO_TARGET_DIR")" in
    hyperbet-solana-e2e-cargo.*)
      rm -rf -- "$CARGO_TARGET_DIR"
      ;;
    *)
      echo "[e2e] refusing to remove unexpected Cargo temp path: $CARGO_TARGET_DIR" >&2
      ;;
  esac
}

E2E_RUNTIME_OWNERSHIP_STARTED=0
cleanup() {
  local exit_code=$?
  if [[ "$E2E_RUNTIME_OWNERSHIP_STARTED" != "1" ]]; then
    cleanup_cargo_target
    trap - EXIT
    exit "$exit_code"
  fi
  kill_pid_file_process "$APP_PID_FILE"
  kill_pid_file_process "$DUEL_BOT_PID_FILE"
  kill_pid_file_process "$BET_SYNC_FEED_PID_FILE"
  kill_pid_file_process "$KEEPER_PID_FILE"
  kill_pid_file_process "$HLS_PRIMARY_ORIGIN_PID_FILE"
  kill_pid_file_process "$HLS_BACKUP_ORIGIN_PID_FILE"
  kill_pid_file_process "$HLS_BACKUP_PID_FILE"
  kill_pid_file_process "$HLS_PID_FILE"
  kill_pid_file_process "$HYPERIA_PID_FILE"
  kill_pid_file_process "$SOLANA_PROXY_PID_FILE"
  kill_pid_file_process "$VALIDATOR_PID_FILE"
  if [[ "$E2E_DUEL_SOURCE" == "real_hyperia" ]]; then
    docker rm -f "$HYPERIA_POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "${E2E_CONTROL_ARTIFACT_PATH:-}" && -f "$CONTROL_PATH" ]]; then
    mkdir -p "$(dirname "$E2E_CONTROL_ARTIFACT_PATH")"
    cp -- "$CONTROL_PATH" "$E2E_CONTROL_ARTIFACT_PATH"
  fi
  rm -f \
    "$APP_PID_FILE" \
    "$VALIDATOR_PID_FILE" \
    "$SOLANA_PROXY_PID_FILE" \
    "$KEEPER_PID_FILE" \
    "$DUEL_BOT_PID_FILE" \
    "$BET_SYNC_FEED_PID_FILE" \
    "$HLS_PID_FILE" \
    "$HLS_BACKUP_PID_FILE" \
    "$HLS_PRIMARY_ORIGIN_PID_FILE" \
    "$HLS_BACKUP_ORIGIN_PID_FILE" \
    "$HLS_PRIMARY_ORIGIN_ENV_FILE" \
    "$HLS_BACKUP_ORIGIN_ENV_FILE" \
    "$HYPERIA_PID_FILE" \
    "$HYPERIA_ENV_FILE" \
    "$HYPERIA_PREPARATION_EVIDENCE_FILE" \
    "$HYPERIA_PREPARATION_FRAME_FILE" \
    "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
    "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE" \
    "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE" \
    "$HYPERIA_CAPTURE_FRAME_STATUS_FILE" \
    "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" \
    "$SOLANA_PROXY_ENV_FILE" \
    "$KEEPER_ENV_FILE" \
    "$DUEL_BOT_ENV_FILE" \
    "$SOLANA_PROXY_FAULT_CONTROL_PATH" \
    "$CONTROL_PATH"
  rm -f "$APP_DIR"/.e2e-hyperia-ordinary-preparation-evidence-*-live-world.json
  cleanup_hls_root
  cleanup_cargo_target
  trap - EXIT
  exit "$exit_code"
}
if [[ -z "$CARGO_TARGET_DIR" ]]; then
  CARGO_TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hyperbet-solana-e2e-cargo.XXXXXX")"
  E2E_OWNS_CARGO_TARGET=1
fi
export CARGO_TARGET_DIR
trap cleanup EXIT

wait_for_solana_rpc() {
  for _ in {1..90}; do
    if curl -s -X POST "$SOLANA_RPC_URL" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}' | grep_q '"blockhash"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_solana_ws() {
  for _ in {1..90}; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${SOLANA_WS_PORT}") >/dev/null 2>&1; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    sleep 1
  done
  return 1
}

read_solana_slot() {
  curl -s -X POST "$SOLANA_RPC_URL" \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"confirmed"}]}' \
    | jq -r '.result // empty'
}

wait_for_solana_block_production() {
  local previous_slot=""
  for _ in {1..120}; do
    local current_slot
    if current_slot="$(read_solana_slot)"; then
      if [[ -n "$previous_slot" && "$current_slot" -gt "$previous_slot" ]]; then
        return 0
      fi
      previous_slot="$current_slot"
    fi
    sleep 1
  done
  return 1
}

wait_for_solana_proxy() {
  for _ in {1..90}; do
    if curl -s -X POST "$SOLANA_PROXY_URL" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' | grep_q '"solana-core"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_app() {
  local url="$1"
  local max_attempts="${2:-90}"
  local watched_pid="${3:-}"
  if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
    echo "[e2e] wait_for_app max attempts must be a positive integer" >&2
    return 2
  fi
  if [[ -n "$watched_pid" && ! "$watched_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "[e2e] wait_for_app watched PID must be a positive integer" >&2
    return 2
  fi
  local attempt
  for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
    if curl -s -o /dev/null -w "%{http_code}" "$url" | grep_q "200"; then
      return 0
    fi
    if [[ -n "$watched_pid" ]] && ! kill -0 "$watched_pid" >/dev/null 2>&1; then
      return 3
    fi
    sleep 1
  done
  return 1
}

STARTED_HLS_PID=""
start_adaptive_hls_encoder() {
  local output_root="$1"
  local transport_service_id="$2"
  local encoder_log="$3"
  local encoder_pid_file="$4"
  local source_label="$5"

  mkdir -p "$output_root/v0" "$output_root/v1"
  echo "[e2e-hls] generating $source_label adaptive 1280x720@4500k + 640x360@900k H.264/AAC stream" >"$encoder_log"
  ffmpeg \
    -hide_banner \
    -loglevel warning \
    -re \
    -f lavfi \
    -i "testsrc2=size=1280x720:rate=30" \
    -re \
    -f lavfi \
    -i "sine=frequency=440:sample_rate=48000" \
    -filter_complex "[0:v]split=2[video720][video360src];[video720]scale=1280:720:flags=lanczos[video720out];[video360src]scale=640:360:flags=lanczos[video360out]" \
    -map "[video720out]" \
    -map 1:a:0 \
    -map "[video360out]" \
    -map 1:a:0 \
    -c:v libx264 \
    -preset ultrafast \
    -tune zerolatency \
    -pix_fmt yuv420p \
    -b:v:0 4500k \
    -maxrate:v:0 4950k \
    -bufsize:v:0 9000k \
    -b:v:1 900k \
    -maxrate:v:1 1000k \
    -bufsize:v:1 1800k \
    -g 60 \
    -keyint_min 60 \
    -sc_threshold 0 \
    -c:a aac \
    -b:a 128k \
    -ar 48000 \
    -ac 2 \
    -f hls \
    -hls_segment_options "mpegts_service_id=${transport_service_id}" \
    -hls_time 2 \
    -hls_list_size 12 \
    -hls_flags delete_segments+program_date_time+independent_segments+temp_file \
    -hls_segment_filename "$output_root/v%v/segment-%06d.ts" \
    -master_pl_name "$HLS_PLAYLIST_FILE" \
    -var_stream_map "v:0,a:0 v:1,a:1" \
    "$output_root/v%v/stream.m3u8" >>"$encoder_log" 2>&1 &
  STARTED_HLS_PID="$!"
  write_pid_file "$encoder_pid_file" "$STARTED_HLS_PID"
}

hash_decoded_hls_stream() {
  local segment_path="$1"
  local stream_selector="$2"
  ffmpeg \
    -hide_banner \
    -loglevel error \
    -i "$segment_path" \
    -map "$stream_selector" \
    -f hash \
    -hash sha256 \
    - | sed -n 's/^SHA256=//p'
}

verify_independent_hls_content_parity() {
  local primary_playlist="$HLS_ROOT/primary/v0/stream.m3u8"
  local backup_playlist="$HLS_ROOT/backup/v0/stream.m3u8"
  local segment_name=""
  for _ in {1..20}; do
    segment_name="$(awk 'NF && substr($0, 1, 1) != "#" { value=$0 } END { print value }' "$primary_playlist")"
    segment_name="$(basename "$segment_name")"
    if [[ -n "$segment_name" ]] && \
      [[ -f "$HLS_ROOT/primary/v0/$segment_name" ]] && \
      [[ -f "$HLS_ROOT/backup/v0/$segment_name" ]] && \
      grep -Fqx "$segment_name" "$backup_playlist"; then
      break
    fi
    segment_name=""
    sleep 0.25
  done
  if [[ -z "$segment_name" ]]; then
    echo "[e2e] independent HLS sources have no common current segment" >&2
    exit 1
  fi

  local primary_segment="$HLS_ROOT/primary/v0/$segment_name"
  local backup_segment="$HLS_ROOT/backup/v0/$segment_name"
  local primary_encoded_sha256
  local backup_encoded_sha256
  local primary_video_sha256
  local backup_video_sha256
  local primary_audio_sha256
  local backup_audio_sha256
  primary_encoded_sha256="$(shasum -a 256 "$primary_segment" | awk '{print $1}')"
  backup_encoded_sha256="$(shasum -a 256 "$backup_segment" | awk '{print $1}')"
  primary_video_sha256="$(hash_decoded_hls_stream "$primary_segment" "0:v:0")"
  backup_video_sha256="$(hash_decoded_hls_stream "$backup_segment" "0:v:0")"
  primary_audio_sha256="$(hash_decoded_hls_stream "$primary_segment" "0:a:0")"
  backup_audio_sha256="$(hash_decoded_hls_stream "$backup_segment" "0:a:0")"
  if [[ -z "$primary_video_sha256" || -z "$primary_audio_sha256" ]] || \
    [[ "$primary_video_sha256" != "$backup_video_sha256" ]] || \
    [[ "$primary_audio_sha256" != "$backup_audio_sha256" ]] || \
    [[ "$primary_encoded_sha256" == "$backup_encoded_sha256" ]]; then
    echo "[e2e] independent HLS source-content parity failed" >&2
    exit 1
  fi

  HLS_CONTENT_PARITY_PATH="$HLS_ROOT/source-content-parity.json"
  jq -n \
    --arg segmentName "$segment_name" \
    --arg primaryEncodedSha256 "$primary_encoded_sha256" \
    --arg backupEncodedSha256 "$backup_encoded_sha256" \
    --arg decodedVideoSha256 "$primary_video_sha256" \
    --arg decodedAudioSha256 "$primary_audio_sha256" \
    '{
      schemaVersion: 1,
      segmentName: $segmentName,
      independentTransportBytes: ($primaryEncodedSha256 != $backupEncodedSha256),
      decodedVideoEquivalent: true,
      decodedAudioEquivalent: true,
      primaryEncodedSha256: $primaryEncodedSha256,
      backupEncodedSha256: $backupEncodedSha256,
      decodedVideoSha256: $decodedVideoSha256,
      decodedAudioSha256: $decodedAudioSha256
    }' >"$HLS_CONTENT_PARITY_PATH"
  chmod 600 "$HLS_CONTENT_PARITY_PATH"
  echo "[e2e] independent HLS decoded video/audio content parity is verified"
}

wait_for_adaptive_hls_encoder() {
  local output_root="$1"
  local encoder_pid="$2"
  local encoder_log="$3"
  local source_label="$4"

  for _ in {1..60}; do
    if [[ -f "$output_root/$HLS_PLAYLIST_FILE" ]] && \
      grep -q '#EXT-X-STREAM-INF' "$output_root/$HLS_PLAYLIST_FILE" && \
      grep -q '#EXT-X-PROGRAM-DATE-TIME' "$output_root/v0/stream.m3u8" && \
      grep -q '#EXTINF' "$output_root/v0/stream.m3u8" && \
      grep -q '#EXT-X-PROGRAM-DATE-TIME' "$output_root/v1/stream.m3u8" && \
      grep -q '#EXTINF' "$output_root/v1/stream.m3u8"; then
      echo "[e2e] $source_label adaptive HLS encoder is ready"
      return 0
    fi
    if ! kill -0 "$encoder_pid" >/dev/null 2>&1; then
      echo "[e2e] $source_label adaptive HLS encoder exited before becoming ready" >&2
      tail -n 80 "$encoder_log" || true
      exit 1
    fi
    sleep 1
  done

  echo "[e2e] $source_label adaptive HLS encoder did not become ready" >&2
  tail -n 80 "$encoder_log" || true
  exit 1
}

start_controlled_hls_origin() {
  local service_name="$1"
  local source_label="$2"
  local origin_pid_file="$3"
  local playlist_url="$4"

  bash "$REPO_ROOT/scripts/e2e-process-control.sh" \
    start "$CONTROL_PATH" "$service_name"
  local origin_pid
  origin_pid="$(cat "$origin_pid_file" 2>/dev/null || true)"
  if [[ ! "$origin_pid" =~ ^[1-9][0-9]*$ ]] || \
    ! kill -0 "$origin_pid" >/dev/null 2>&1; then
    echo "[e2e] $source_label HLS origin has no live supervised PID" >&2
    exit 1
  fi
  echo "[e2e] $source_label HLS origin is ready at $playlist_url"
}

start_timestamped_test_hls() {
  if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
    if [[ -z "$HLS_ROOT" || ! -f "$HLS_ROOT/$HLS_PLAYLIST_FILE" || ! -f "$HYPERIA_RENDERER_STATUS_FILE" ]]; then
      echo "[e2e] full_3d Hyperia HLS source is not ready" >&2
      exit 1
    fi
    echo "[e2e] using the owned Hyperia 3D renderer HLS source"
    return 0
  fi
  if ! has_cmd ffmpeg; then
    echo "[e2e] ffmpeg is required for verified HLS playback" >&2
    exit 1
  fi

  HLS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hyperbet-solana-e2e-hls.XXXXXX")"
  if [[ "$E2E_HLS_FAILOVER" == "true" ]]; then
    mkdir -p "$HLS_ROOT/primary" "$HLS_ROOT/backup"

    start_adaptive_hls_encoder \
      "$HLS_ROOT/primary" \
      "1" \
      "$HLS_LOG" \
      "$HLS_PID_FILE" \
      "primary"
    HLS_PID="$STARTED_HLS_PID"
    start_adaptive_hls_encoder \
      "$HLS_ROOT/backup" \
      "2" \
      "$HLS_BACKUP_LOG" \
      "$HLS_BACKUP_PID_FILE" \
      "backup"
    HLS_BACKUP_PID="$STARTED_HLS_PID"
    wait_for_adaptive_hls_encoder \
      "$HLS_ROOT/primary" "$HLS_PID" "$HLS_LOG" "primary"
    wait_for_adaptive_hls_encoder \
      "$HLS_ROOT/backup" "$HLS_BACKUP_PID" "$HLS_BACKUP_LOG" "backup"
    verify_independent_hls_content_parity

    if [[ -z "$HLS_PRIMARY_ORIGIN_PORT" ]]; then
      HLS_PRIMARY_ORIGIN_PORT="$(find_available_loopback_port)"
    fi
    validate_loopback_port \
      "E2E_HLS_PRIMARY_ORIGIN_PORT" "$HLS_PRIMARY_ORIGIN_PORT"
    if [[ -z "$HLS_BACKUP_ORIGIN_PORT" ]]; then
      HLS_BACKUP_ORIGIN_PORT="$(find_available_loopback_port)"
      while [[ "$HLS_BACKUP_ORIGIN_PORT" == "$HLS_PRIMARY_ORIGIN_PORT" ]]; do
        HLS_BACKUP_ORIGIN_PORT="$(find_available_loopback_port)"
      done
    fi
    validate_loopback_port \
      "E2E_HLS_BACKUP_ORIGIN_PORT" "$HLS_BACKUP_ORIGIN_PORT"
    if [[ "$HLS_PRIMARY_ORIGIN_PORT" == "$HLS_BACKUP_ORIGIN_PORT" ]]; then
      echo "[e2e] primary and backup HLS origins must use distinct ports" >&2
      exit 1
    fi
    HLS_PRIMARY_URL="http://127.0.0.1:${HLS_PRIMARY_ORIGIN_PORT}/live/primary/$HLS_PLAYLIST_FILE"
    HLS_BACKUP_URL="http://127.0.0.1:${HLS_BACKUP_ORIGIN_PORT}/live/backup/$HLS_PLAYLIST_FILE"
    write_env_file \
      "$HLS_PRIMARY_ORIGIN_ENV_FILE" \
      HLS_ORIGIN_LABEL "primary" \
      HLS_ORIGIN_PORT "$HLS_PRIMARY_ORIGIN_PORT" \
      HLS_ORIGIN_ROOT "$HLS_ROOT"
    write_env_file \
      "$HLS_BACKUP_ORIGIN_ENV_FILE" \
      HLS_ORIGIN_LABEL "backup" \
      HLS_ORIGIN_PORT "$HLS_BACKUP_ORIGIN_PORT" \
      HLS_ORIGIN_ROOT "$HLS_ROOT"
    write_control_file
    start_controlled_hls_origin \
      "hlsPrimaryOrigin" "primary" "$HLS_PRIMARY_ORIGIN_PID_FILE" "$HLS_PRIMARY_URL"
    HLS_PRIMARY_ORIGIN_PID="$(cat "$HLS_PRIMARY_ORIGIN_PID_FILE")"
    start_controlled_hls_origin \
      "hlsBackupOrigin" "backup" "$HLS_BACKUP_ORIGIN_PID_FILE" "$HLS_BACKUP_URL"
    HLS_BACKUP_ORIGIN_PID="$(cat "$HLS_BACKUP_ORIGIN_PID_FILE")"
    echo "[e2e] independent dual-encoder, dual-origin HLS fixture is ready"
    return 0
  fi
  if [[ "$E2E_HLS_ADAPTIVE" == "true" ]]; then
    start_adaptive_hls_encoder \
      "$HLS_ROOT" "1" "$HLS_LOG" "$HLS_PID_FILE" "single-source"
    HLS_PID="$STARTED_HLS_PID"
    wait_for_adaptive_hls_encoder \
      "$HLS_ROOT" "$HLS_PID" "$HLS_LOG" "single-source"
    HLS_PRIMARY_URL="http://127.0.0.1:$APP_PORT/live/$HLS_PLAYLIST_FILE"
    return 0
  fi

  echo "[e2e-hls] generating timestamped ${HLS_VIDEO_WIDTH}x${HLS_VIDEO_HEIGHT} H.264/AAC test stream at ${HLS_VIDEO_BITRATE_KBPS}+${HLS_AUDIO_BITRATE_KBPS} kbps" >"$HLS_LOG"
  ffmpeg \
    -hide_banner \
    -loglevel warning \
    -re \
    -f lavfi \
    -i "testsrc2=size=${HLS_VIDEO_WIDTH}x${HLS_VIDEO_HEIGHT}:rate=30" \
    -re \
    -f lavfi \
    -i "sine=frequency=440:sample_rate=48000" \
    -map 0:v:0 \
    -map 1:a:0 \
    -c:v libx264 \
    -preset ultrafast \
    -tune zerolatency \
    -pix_fmt yuv420p \
    -b:v "${HLS_VIDEO_BITRATE_KBPS}k" \
    -maxrate "${HLS_VIDEO_MAXRATE_KBPS}k" \
    -bufsize "${HLS_VIDEO_BUFSIZE_KBPS}k" \
    -g 30 \
    -keyint_min 30 \
    -sc_threshold 0 \
    -c:a aac \
    -b:a "${HLS_AUDIO_BITRATE_KBPS}k" \
    -ar 48000 \
    -ac 2 \
    -f hls \
    -hls_time 1 \
    -hls_list_size 12 \
    -hls_flags delete_segments+program_date_time+independent_segments+temp_file \
    -hls_segment_filename "$HLS_ROOT/segment-%06d.ts" \
    "$HLS_ROOT/$HLS_PLAYLIST_FILE" >>"$HLS_LOG" 2>&1 &
  HLS_PID="$!"
  write_pid_file "$HLS_PID_FILE" "$HLS_PID"

  for _ in {1..60}; do
    if [[ -f "$HLS_ROOT/$HLS_PLAYLIST_FILE" ]] && \
      grep -q '#EXT-X-PROGRAM-DATE-TIME' "$HLS_ROOT/$HLS_PLAYLIST_FILE" && \
      grep -q '#EXTINF' "$HLS_ROOT/$HLS_PLAYLIST_FILE"; then
      HLS_PRIMARY_URL="http://127.0.0.1:$APP_PORT/live/$HLS_PLAYLIST_FILE"
      echo "[e2e] timestamped HLS stream is ready"
      return 0
    fi
    if ! kill -0 "$HLS_PID" >/dev/null 2>&1; then
      echo "[e2e] timestamped HLS stream exited before becoming ready" >&2
      tail -n 80 "$HLS_LOG" || true
      exit 1
    fi
    sleep 1
  done

  echo "[e2e] timestamped HLS stream did not become ready" >&2
  tail -n 80 "$HLS_LOG" || true
  exit 1
}

wait_for_hyperia_postgres() {
  for _ in {1..90}; do
    if docker exec "$HYPERIA_POSTGRES_CONTAINER" \
      pg_isready -U "$HYPERIA_POSTGRES_USER" -d "$HYPERIA_POSTGRES_DB" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

capture_qualified_full_3d_preparation_frame() {
  local output_path="$1"
  local expected_slot="$2"
  local expected_pair_shot="$3"
  local expected_preparation_identity="$4"
  local capture_result=""
  local capture_state=""
  local output_filename=""
  local output_sha256=""
  local random_suffix=""
  local request_id=""
  local requested_at_ms=""
  local request_temporary=""
  local post_capture_renderer_status=""
  local post_capture_public_state=""
  local post_capture_preparation_identity=""

  output_filename="$(basename "$output_path")"
  if [[ "$(dirname "$output_path")" != "$APP_DIR" || \
    ! "$output_filename" =~ ^[a-z0-9.][a-z0-9._-]{0,126}\.png$ ]]; then
    echo "[e2e] refused unsafe preparation-frame output path" >&2
    return 1
  fi
  random_suffix="$(LC_ALL=C od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
  if [[ ! "$random_suffix" =~ ^[0-9a-f]{32}$ ]]; then
    echo "[e2e] could not generate preparation-frame request identity" >&2
    return 1
  fi
  request_id="prep-${expected_slot}-${random_suffix}"
  requested_at_ms="$(date +%s000)"
  request_temporary="${HYPERIA_CAPTURE_FRAME_REQUEST_FILE}.${request_id}.tmp"
  rm -f \
    "$output_path" \
    "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE" \
    "$HYPERIA_CAPTURE_FRAME_STATUS_FILE" \
    "$request_temporary"
  if ! (
    umask 077
    jq -n \
      --arg requestId "$request_id" \
      --arg outputFilename "$output_filename" \
      --arg expectedCameraTargetSlot "$expected_slot" \
      --argjson requestedAtMs "$requested_at_ms" \
      --argjson expectedPairShot "$expected_pair_shot" \
      '{
        schemaVersion: 2,
        requestId: $requestId,
        outputFilename: $outputFilename,
        requestedAtMs: $requestedAtMs,
        expectedCameraTargetSlot: $expectedCameraTargetSlot,
        expectedPairShot: $expectedPairShot
      }' >"$request_temporary"
  ); then
    rm -f "$request_temporary"
    return 1
  fi
  chmod 600 "$request_temporary"
  mv -- "$request_temporary" "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE"

  for ((request_attempt = 0; request_attempt < 100; request_attempt += 1)); do
    if [[ -f "$HYPERIA_CAPTURE_FRAME_STATUS_FILE" ]]; then
      capture_result="$(<"$HYPERIA_CAPTURE_FRAME_STATUS_FILE")"
      if jq -e --arg requestId "$request_id" \
        '.source == "capture-browser-host" and
         .schemaVersion == 2 and
         .requestId == $requestId' \
        <<<"$capture_result" >/dev/null 2>&1; then
        capture_state="$(jq -r '.state // empty' <<<"$capture_result")"
        if [[ "$capture_state" == "completed" ]]; then
          break
        fi
        if [[ "$capture_state" == "failed" ]]; then
          echo "[e2e] preparation-frame request failed: $(jq -r '.reason // "unknown"' <<<"$capture_result")" >&2
          break
        fi
      fi
    fi
    sleep 0.1
  done
  rm -f "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE"

  if [[ "$capture_state" != "completed" || ! -s "$output_path" ]] || \
    ! jq -e \
      --arg requestId "$request_id" \
      --arg outputFilename "$output_filename" \
      --argjson requestedAtMs "$requested_at_ms" \
      --arg expectedSlot "$expected_slot" \
      --argjson expectedPairShot "$expected_pair_shot" '
        .source == "capture-browser-host" and
        .schemaVersion == 2 and
        .requestId == $requestId and
        .state == "completed" and
        .requestedAtMs == $requestedAtMs and
        .outputFilename == $outputFilename and
        .width == 1280 and
        .height == 720 and
        .cameraTargetSlot == $expectedSlot and
        .preparationPairShotActive == $expectedPairShot and
        (.sha256 | test("^[0-9a-f]{64}$")) and
        (.capturedAtMs | type == "number") and
        .capturedAtMs >= .requestedAtMs
      ' <<<"$capture_result" >/dev/null 2>&1; then
    rm -f "$output_path" "$HYPERIA_CAPTURE_FRAME_STATUS_FILE"
    return 1
  fi
  output_sha256="$(shasum -a 256 "$output_path" | awk '{print $1}')"
  if [[ "$output_sha256" != "$(jq -r '.sha256' <<<"$capture_result")" ]]; then
    rm -f "$output_path"
    rm -f "$HYPERIA_CAPTURE_FRAME_STATUS_FILE"
    return 1
  fi

  post_capture_renderer_status="$(<"$HYPERIA_RENDERER_STATUS_FILE")"
  post_capture_public_state="$(curl -fsS "$HYPERIA_URL/api/streaming/state" 2>/dev/null || true)"
  post_capture_preparation_identity="$(jq -r '
    [.preparation.selectedAt, .preparation.expiresAt, .preparation.agent1.id, .preparation.agent2.id] | @tsv
  ' <<<"$post_capture_public_state" 2>/dev/null || true)"
  if [[ "$post_capture_preparation_identity" != "$expected_preparation_identity" ]] || \
    ! jq -e \
      --arg expectedSlot "$expected_slot" \
      --argjson expectedPairShot "$expected_pair_shot" '
        .source == "external-rtmp-bridge" and
        .rendererHealth.ready == true and
        .rendererHealth.degradedReason == null and
        .rendererHealth.phase == "IDLE" and
        .rendererHealth.diagnostics.sceneReadiness.ready == true and
        .rendererHealth.diagnostics.sceneReadiness.phase == "IDLE" and
        .rendererHealth.diagnostics.sceneReadiness.expectedAgentCount == 2 and
        .rendererHealth.diagnostics.sceneReadiness.loadedExpectedAgentCount == 2 and
        .rendererHealth.diagnostics.sceneReadiness.renderedAgentCount == 2 and
        .rendererHealth.diagnostics.sceneReadiness.preparationActive == true and
        .rendererHealth.diagnostics.sceneReadiness.preparationShotActive == true and
        .rendererHealth.diagnostics.sceneReadiness.cameraTargetMatchesExpected == true and
        .rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == $expectedSlot and
        (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index($expectedSlot) != null) and
        (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index($expectedSlot) != null) and
        .rendererHealth.diagnostics.sceneReadiness.croppedVisibleAgentBodyCount == 0 and
        .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentBodyNdcSpan >= 0.55 and
        .rendererHealth.diagnostics.sceneReadiness.maximumVisibleAgentBodyNdcSpan <= 0.75 and
        .rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == $expectedPairShot and
        (if $expectedPairShot then
          .rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 2 and
          (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent1") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent2") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent1") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent2") != null) and
          .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation >= 0.24
        else
          .rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 1 and
          .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation == null
        end) and
        .stats.ffmpegRunning == true and
        .stats.audioSource == "browser" and
        .stats.audioHealthy == true and
        .stats.audioDroppedChunks == 0 and
        .stats.audioTrimmedChunks == 0 and
        .browserAudioCaptureHealth.contextState == "running" and
        .browserAudioCaptureHealth.sourceContextState == "running" and
        .browserAudioCaptureHealth.trackState == "live" and
        .browserAudioCaptureHealth.sampleRate == 48000 and
        .browserAudioCaptureHealth.channels == 2 and
        .browserAudioCaptureHealth.droppedChunks == 0 and
        .browserAudioCaptureHealth.pendingWrites == 0
      ' <<<"$post_capture_renderer_status" >/dev/null 2>&1 || \
    ! jq -e \
      --arg expectedSlot "$expected_slot" '
        .type == "STREAMING_STATE_UPDATE" and
        .cycle.phase == "IDLE" and
        .preparation.schemaVersion == 2 and
        (.preparation.status == "preparing" or .preparation.status == "ready") and
        (if $expectedSlot == "agent1" then
          .cameraTarget == .preparation.agent1.id
        else
          .cameraTarget == .preparation.agent2.id
        end)
      ' <<<"$post_capture_public_state" >/dev/null 2>&1; then
    rm -f "$output_path"
    return 1
  fi

  chmod 600 "$output_path"
  rm -f "$HYPERIA_CAPTURE_FRAME_STATUS_FILE"
  captured_frame_renderer_status="$post_capture_renderer_status"
  captured_frame_public_state="$post_capture_public_state"
  return 0
}

capture_full_3d_public_preparation() {
  local public_state=""
  local captured_at_ms=""
  local renderer_status=""
  local last_idle_renderer_status=""
  local last_ready_preparation_public_state=""
  local preparation_identity=""
  local agent1_shot_renderer_status=""
  local agent1_shot_public_state=""
  local agent2_shot_renderer_status=""
  local agent2_shot_public_state=""
  local agent1_shot_frame_path=""
  local agent2_shot_frame_path=""
  local captured_frame_renderer_status=""
  local captured_frame_public_state=""
  local retained_preparation_renderer_status=""
  local segment_path=""
  local segment_name=""
  # The full-3D preparation authority covers the complete bounded startup
  # readiness envelope. This lets a cold capture candidate be supervised into
  # one replacement without expiring the exact preparation later bound to the
  # frozen market. Directed cuts are retained while that exact preparation is
  # active; durable ready authority is then checked independently below.
  local preparation_observation_attempts=1200
  for ((attempt = 0; attempt < preparation_observation_attempts; attempt += 1)); do
    public_state="$(curl -fsS "$HYPERIA_URL/api/streaming/state" 2>/dev/null || true)"
    if [[ -f "$HYPERIA_RENDERER_STATUS_FILE" ]]; then
      renderer_status="$(<"$HYPERIA_RENDERER_STATUS_FILE")"
      if jq -e '.rendererHealth.phase == "IDLE"' \
        <<<"$renderer_status" >/dev/null 2>&1; then
        last_idle_renderer_status="$renderer_status"
      fi
    fi
    if jq -e '
      .type == "STREAMING_STATE_UPDATE" and
      .cycle.phase == "IDLE" and
      .preparation.status == "ready"
    ' <<<"$public_state" >/dev/null 2>&1; then
      last_ready_preparation_public_state="$public_state"
    fi
    if [[ -f "$HLS_ROOT/$HLS_PLAYLIST_FILE" ]] && \
      grep -q '#EXT-X-PROGRAM-DATE-TIME' "$HLS_ROOT/$HLS_PLAYLIST_FILE" && \
      grep -q '#EXTINF' "$HLS_ROOT/$HLS_PLAYLIST_FILE" && \
      [[ -f "$HYPERIA_RENDERER_STATUS_FILE" ]] && \
      jq -e '
        .source == "external-rtmp-bridge" and
        .rendererHealth.ready == true and
        .rendererHealth.degradedReason == null and
        .rendererHealth.phase == "IDLE" and
        .rendererHealth.diagnostics.sceneReadiness.ready == true and
        .rendererHealth.diagnostics.sceneReadiness.phase == "IDLE" and
        .rendererHealth.diagnostics.sceneReadiness.expectedAgentCount == 2 and
        .rendererHealth.diagnostics.sceneReadiness.loadedExpectedAgentCount == 2 and
        .rendererHealth.diagnostics.sceneReadiness.visibleExpectedAgentCount >= 1 and
        .rendererHealth.diagnostics.sceneReadiness.renderedAgentCount == 2 and
        .rendererHealth.diagnostics.sceneReadiness.preparationActive == true and
        .rendererHealth.diagnostics.sceneReadiness.preparationShotActive == true and
        .rendererHealth.diagnostics.sceneReadiness.cameraTargetMatchesExpected == true and
        (.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent1" or
         .rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent2") and
        ((.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent1" and
          (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent1") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent1") != null)) or
         (.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent2" and
          (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent2") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent2") != null))) and
        .rendererHealth.diagnostics.sceneReadiness.croppedVisibleAgentBodyCount == 0 and
        .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentBodyNdcSpan >= 0.55 and
        .rendererHealth.diagnostics.sceneReadiness.maximumVisibleAgentBodyNdcSpan <= 0.75 and
        ((.rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == true and
          .rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 2 and
          (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent1") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent2") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent1") != null) and
          (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent2") != null) and
          .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation >= 0.24) or
         (.rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == false and
          .rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 1 and
          .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation == null)) and
        .stats.ffmpegRunning == true and
        .stats.audioSource == "browser" and
        .stats.audioHealthy == true and
        .stats.audioChunks > 0 and
        .stats.audioDroppedChunks == 0 and
        .stats.audioTrimmedChunks == 0 and
        .browserAudioCaptureHealth.contextState == "running" and
        .browserAudioCaptureHealth.sourceContextState == "running" and
        .browserAudioCaptureHealth.trackState == "live" and
        .browserAudioCaptureHealth.sampleRate == 48000 and
        .browserAudioCaptureHealth.channels == 2 and
        .browserAudioCaptureHealth.droppedChunks == 0 and
        .browserAudioCaptureHealth.pendingWrites == 0
      ' "$HYPERIA_RENDERER_STATUS_FILE" >/dev/null 2>&1 && \
      jq -e '
      .type == "STREAMING_STATE_UPDATE" and
      .cycle.phase == "IDLE" and
      .preparation.schemaVersion == 2 and
      (.preparation.status == "preparing" or .preparation.status == "ready") and
      (.preparation.agent1.id | type == "string" and length > 0) and
      (.preparation.agent2.id | type == "string" and length > 0) and
      .preparation.agent1.id != .preparation.agent2.id and
      (.preparation.agent1.activityTrail | index("planning") != null) and
      (.preparation.agent2.activityTrail | index("planning") != null) and
      (.cameraTarget == .preparation.agent1.id or
       .cameraTarget == .preparation.agent2.id)
      ' <<<"$public_state" >/dev/null 2>&1; then
      local renderer_target_slot
      local public_target_slot
      local current_preparation_identity
      local preparation_pair_shot_active
      renderer_target_slot="$(jq -r '.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot // empty' <<<"$renderer_status")"
      preparation_pair_shot_active="$(jq -r '.rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == true' <<<"$renderer_status")"
      public_target_slot="$(jq -r '
        if .cameraTarget == .preparation.agent1.id then "agent1"
        elif .cameraTarget == .preparation.agent2.id then "agent2"
        else ""
        end
      ' <<<"$public_state")"
      current_preparation_identity="$(jq -r '[.preparation.selectedAt, .preparation.expiresAt, .preparation.agent1.id, .preparation.agent2.id] | @tsv' <<<"$public_state")"
      if [[ -n "$current_preparation_identity" && \
        -n "$preparation_identity" && \
        "$current_preparation_identity" != "$preparation_identity" ]]; then
        agent1_shot_renderer_status=""
        agent1_shot_public_state=""
        agent2_shot_renderer_status=""
        agent2_shot_public_state=""
        agent1_shot_frame_path=""
        agent2_shot_frame_path=""
        rm -f \
          "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
          "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE"
      fi
      preparation_identity="$current_preparation_identity"
      # A qualified pair shot proves both contestants in one simultaneous,
      # uncropped frame. Waiting for a redundant target cut here can discard
      # valid public preparation merely because the ready window ends before
      # the camera's next deterministic hold expires. Directed coverage still
      # requires one independently qualified frame for each contestant. Each
      # accepted observation now captures the already-running browser directly
      # and revalidates the same camera target afterward; renderer telemetry can
      # no longer be paired with an unrelated frame from a later HLS segment.
      if [[ "$renderer_target_slot" == "$public_target_slot" && \
        "$preparation_pair_shot_active" == "true" ]]; then
        captured_frame_renderer_status=""
        captured_frame_public_state=""
        if capture_qualified_full_3d_preparation_frame \
          "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
          "$renderer_target_slot" \
          true \
          "$preparation_identity"; then
          cp -- \
            "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
            "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE"
          chmod 600 "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE"
          agent1_shot_renderer_status="$captured_frame_renderer_status"
          agent1_shot_public_state="$captured_frame_public_state"
          agent2_shot_renderer_status="$captured_frame_renderer_status"
          agent2_shot_public_state="$captured_frame_public_state"
          agent1_shot_frame_path="$HYPERIA_PREPARATION_AGENT1_FRAME_FILE"
          agent2_shot_frame_path="$HYPERIA_PREPARATION_AGENT2_FRAME_FILE"
        fi
      elif [[ "$renderer_target_slot" == "$public_target_slot" && \
        "$renderer_target_slot" == "agent1" && \
        -z "$agent1_shot_frame_path" ]]; then
        captured_frame_renderer_status=""
        captured_frame_public_state=""
        if capture_qualified_full_3d_preparation_frame \
          "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
          agent1 \
          false \
          "$preparation_identity"; then
          agent1_shot_renderer_status="$captured_frame_renderer_status"
          agent1_shot_public_state="$captured_frame_public_state"
          agent1_shot_frame_path="$HYPERIA_PREPARATION_AGENT1_FRAME_FILE"
        fi
      elif [[ "$renderer_target_slot" == "$public_target_slot" && \
        "$renderer_target_slot" == "agent2" && \
        -z "$agent2_shot_frame_path" ]]; then
        captured_frame_renderer_status=""
        captured_frame_public_state=""
        if capture_qualified_full_3d_preparation_frame \
          "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE" \
          agent2 \
          false \
          "$preparation_identity"; then
          agent2_shot_renderer_status="$captured_frame_renderer_status"
          agent2_shot_public_state="$captured_frame_public_state"
          agent2_shot_frame_path="$HYPERIA_PREPARATION_AGENT2_FRAME_FILE"
        fi
      fi
      if [[ -n "$agent1_shot_renderer_status" && \
        -n "$agent2_shot_renderer_status" && \
        -s "$agent1_shot_frame_path" && \
        -s "$agent2_shot_frame_path" ]]; then
        captured_at_ms="$(date +%s000)"
        break
      fi
    fi
    sleep 0.25
  done
  if [[ -z "$captured_at_ms" ]]; then
    local failure_artifact_dir
    failure_artifact_dir="$APP_DIR/test-results/hyperia-preparation-gate-failure-$(date +%s000)"
    mkdir -p "$failure_artifact_dir"
    printf '%s\n' "${renderer_status:-null}" > \
      "$failure_artifact_dir/final-renderer-status.json"
    printf '%s\n' "${public_state:-null}" > \
      "$failure_artifact_dir/final-public-state.json"
    printf '%s\n' "${last_idle_renderer_status:-null}" > \
      "$failure_artifact_dir/last-idle-renderer-status.json"
    printf '%s\n' "${last_ready_preparation_public_state:-null}" > \
      "$failure_artifact_dir/last-ready-preparation-public-state.json"
    printf '%s\n' "${agent1_shot_renderer_status:-null}" > \
      "$failure_artifact_dir/agent1-shot-renderer-status.json"
    printf '%s\n' "${agent1_shot_public_state:-null}" > \
      "$failure_artifact_dir/agent1-shot-public-state.json"
    printf '%s\n' "${agent2_shot_renderer_status:-null}" > \
      "$failure_artifact_dir/agent2-shot-renderer-status.json"
    printf '%s\n' "${agent2_shot_public_state:-null}" > \
      "$failure_artifact_dir/agent2-shot-public-state.json"
    if [[ -f "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" ]]; then
      cp "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" \
        "$failure_artifact_dir/ordinary-preparation-evidence.json"
    fi
    if [[ -f "$HYPERIA_LOG" ]]; then
      cp "$HYPERIA_LOG" "$failure_artifact_dir/hyperia.log"
    fi
    chmod 600 "$failure_artifact_dir"/*
    echo "[e2e] retained preparation observation failure at $failure_artifact_dir" >&2
    echo "[e2e] full_3d public preparation did not produce exact two-agent visual coverage" >&2
    curl -fsS "$HYPERIA_URL/api/streaming/state" 2>/dev/null | jq '.' || true
    exit 1
  fi

  # Preserve the exact HLS segment and renderer authority while the second
  # directed cut is still inside its established camera hold. Durable private
  # readiness may complete later, after this public preparation frame existed.
  local captured_at_seconds=$((captured_at_ms / 1000))
  for _ in {1..80}; do
    segment_name="$(awk 'NF && substr($0, 1, 1) != "#" { value=$0 } END { print value }' "$HLS_ROOT/$HLS_PLAYLIST_FILE")"
    segment_name="$(basename "$segment_name")"
    segment_path="$HLS_ROOT/$segment_name"
    if [[ -n "$segment_name" && -f "$segment_path" ]]; then
      local segment_modified_at=""
      segment_modified_at="$(stat -f '%m' "$segment_path" 2>/dev/null || stat -c '%Y' "$segment_path" 2>/dev/null || true)"
      if [[ "$segment_modified_at" =~ ^[0-9]+$ ]] && \
        (( segment_modified_at >= captured_at_seconds + 2 )); then
        break
      fi
    fi
    segment_path=""
    sleep 0.25
  done
  if [[ -z "$segment_path" ]]; then
    echo "[e2e] no directed-preparation HLS segment became available" >&2
    exit 1
  fi
  local retained_preparation_segment_path="$HLS_ROOT/preparation-evidence-segment.ts"
  cp "$segment_path" "$retained_preparation_segment_path"
  segment_path="$retained_preparation_segment_path"
  # Audio capture is continuously serial: one healthy PCM write can be in
  # flight at an arbitrary status-file sample. Retain an exact drained sample
  # from the same preparation identity instead of racing that transient write
  # after the qualified browser frame and HLS segment already exist.
  local retained_preparation_public_state=""
  local retained_preparation_identity=""
  retained_preparation_renderer_status=""
  for _ in {1..80}; do
    renderer_status="$(<"$HYPERIA_RENDERER_STATUS_FILE")"
    retained_preparation_public_state="$(curl -fsS "$HYPERIA_URL/api/streaming/state" 2>/dev/null || true)"
    retained_preparation_identity="$(jq -r '
      [.preparation.selectedAt, .preparation.expiresAt, .preparation.agent1.id, .preparation.agent2.id] | @tsv
    ' <<<"$retained_preparation_public_state" 2>/dev/null || true)"
    if [[ "$retained_preparation_identity" == "$preparation_identity" ]] && \
      jq -e \
        --argjson capturedAtMs "$captured_at_ms" '
          .source == "external-rtmp-bridge" and
          .rendererHealth.ready == true and
          .rendererHealth.degradedReason == null and
          .rendererHealth.phase == "IDLE" and
          .rendererHealth.updatedAt >= $capturedAtMs and
          .rendererHealth.diagnostics.sceneReadiness.ready == true and
          .rendererHealth.diagnostics.sceneReadiness.phase == "IDLE" and
          .rendererHealth.diagnostics.sceneReadiness.preparationActive == true and
          .rendererHealth.diagnostics.sceneReadiness.preparationShotActive == true and
          .stats.ffmpegRunning == true and
          .stats.audioSource == "browser" and
          .stats.audioHealthy == true and
          .stats.audioDroppedChunks == 0 and
          .stats.audioTrimmedChunks == 0 and
          .browserAudioCaptureHealth.droppedChunks == 0 and
          .browserAudioCaptureHealth.pendingWrites == 0
        ' <<<"$renderer_status" >/dev/null 2>&1 && \
      jq -e '
        .type == "STREAMING_STATE_UPDATE" and
        .cycle.phase == "IDLE" and
        .preparation.schemaVersion == 2 and
        (.preparation.status == "preparing" or .preparation.status == "ready")
      ' <<<"$retained_preparation_public_state" >/dev/null 2>&1; then
      retained_preparation_renderer_status="$renderer_status"
      break
    fi
    sleep 0.1
  done
  if [[ -z "$retained_preparation_renderer_status" ]]; then
    echo "[e2e] retained preparation renderer authority never reached an audio-drained snapshot" >&2
    printf '%s\n' "${renderer_status:-null}" | jq '.' >&2 || true
    exit 1
  fi

  # Directed preparation cuts can be captured while the selected agents are
  # still working. Keep that honest visual evidence, then independently wait
  # for the same durable preparation to reach ready before publishing its
  # private authority or allowing the downstream market checks to proceed.
  local ready_preparation_observed="false"
  local captured_agent1_id
  local captured_agent2_id
  local captured_agent1_id_base64
  local captured_agent2_id_base64
  local captured_selected_at
  local captured_expires_at
  captured_agent1_id="$(jq -r '.preparation.agent1.id' <<<"$public_state")"
  captured_agent2_id="$(jq -r '.preparation.agent2.id' <<<"$public_state")"
  captured_agent1_id_base64="$(jq -nr --arg value "$captured_agent1_id" '$value | @base64')"
  captured_agent2_id_base64="$(jq -nr --arg value "$captured_agent2_id" '$value | @base64')"
  captured_selected_at="$(jq -r '.preparation.selectedAt' <<<"$public_state")"
  captured_expires_at="$(jq -r '.preparation.expiresAt' <<<"$public_state")"
  if [[ ! "$captured_agent1_id_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ || \
    ! "$captured_agent2_id_base64" =~ ^[A-Za-z0-9+/]+={0,2}$ || \
    ! "$captured_selected_at" =~ ^[0-9]+$ || \
    ! "$captured_expires_at" =~ ^[0-9]+$ ]]; then
    echo "[e2e] captured preparation identity is not SQL-safe canonical data" >&2
    exit 1
  fi
  for _ in {1..240}; do
    ready_preparation_observed="$(
      docker exec \
        -e "PGPASSWORD=$HYPERIA_POSTGRES_PASSWORD" \
        "$HYPERIA_POSTGRES_CONTAINER" \
        psql -X -q -t -A \
        -U "$HYPERIA_POSTGRES_USER" \
        -d "$HYPERIA_POSTGRES_DB" \
        -c "SELECT EXISTS (
              SELECT 1
                FROM streaming_duel_preparations
               WHERE status = 'ready'
                 AND \"agent1Id\" = convert_from(decode('$captured_agent1_id_base64', 'base64'), 'UTF8')
                 AND \"agent2Id\" = convert_from(decode('$captured_agent2_id_base64', 'base64'), 'UTF8')
                 AND \"selectedAt\" = $captured_selected_at
                 AND \"expiresAt\" = $captured_expires_at
            );" 2>/dev/null | tr -d '[:space:]'
    )"
    if [[ "$ready_preparation_observed" == "t" ]]; then
      break
    fi
    sleep 0.25
  done
  if [[ "$ready_preparation_observed" != "t" ]]; then
    echo "[e2e] captured preparation never reached durable ready authority" >&2
    exit 1
  fi

  local authority_state
  authority_state="$(
    docker exec \
      -e "PGPASSWORD=$HYPERIA_POSTGRES_PASSWORD" \
      "$HYPERIA_POSTGRES_CONTAINER" \
      psql -X -q -t -A \
      -U "$HYPERIA_POSTGRES_USER" \
      -d "$HYPERIA_POSTGRES_DB" \
      -c '
        SELECT json_build_object(
          '\''preparationId'\'', preparation."preparationId",
          '\''agent1Id'\'', preparation."agent1Id",
          '\''agent2Id'\'', preparation."agent2Id",
          '\''status'\'', preparation.status,
          '\''selectedAt'\'', preparation."selectedAt",
          '\''expiresAt'\'', preparation."expiresAt",
          '\''agent1ReadyAt'\'', preparation."agent1ReadyAt",
          '\''agent2ReadyAt'\'', preparation."agent2ReadyAt",
          '\''activityRows'\'', COALESCE((
            SELECT json_agg(json_build_object(
              '\''agentId'\'', activity."agentId",
              '\''activity'\'', activity.activity,
              '\''mode'\'', activity.mode,
              '\''occurredAt'\'', activity."occurredAt",
              '\''revision'\'', activity."activitySequence"
            ) ORDER BY activity."activitySequence")
            FROM streaming_duel_preparation_public_activities AS activity
            WHERE activity."preparationId" = preparation."preparationId"
          ), '\''[]'\''::json),
          '\''bankOpenCount'\'', (
            SELECT count(*)::int
            FROM streaming_duel_bank_open_events AS bank_open
            WHERE bank_open."preparationId" = preparation."preparationId"
          ),
          '\''planOperationCount'\'', (
            SELECT count(*)::int
            FROM operations_log AS operation
            WHERE operation."operationType" = '\''duel_preparation_plan'\''
              AND operation.completed = true
              AND operation."operationState"->>'\''preparationId'\'' =
                preparation."preparationId"
          ),
          '\''planOperations'\'', COALESCE((
            SELECT json_agg(json_build_object(
              '\''agentId'\'', operation."playerId",
              '\''committedInventory'\'', operation."operationState"->'\''committed'\''->'\''inventory'\'',
              '\''committedBank'\'', operation."operationState"->'\''committed'\''->'\''bank'\''
            ) ORDER BY operation."playerId")
            FROM operations_log AS operation
            WHERE operation."operationType" = '\''duel_preparation_plan'\''
              AND operation.completed = true
              AND operation."operationState"->>'\''preparationId'\'' =
                preparation."preparationId"
          ), '\''[]'\''::json)
        )
        FROM streaming_duel_preparations AS preparation
        WHERE preparation.status = '\''ready'\''
        ORDER BY preparation."selectedAt" DESC
        LIMIT 1;
      '
  )"
  if ! jq -e \
    --argjson publicState "$public_state" '
      . as $authority |
      .status == "ready" and
      .agent1Id == $publicState.preparation.agent1.id and
      .agent2Id == $publicState.preparation.agent2.id and
      .selectedAt == $publicState.preparation.selectedAt and
      .expiresAt == $publicState.preparation.expiresAt and
      (.agent1ReadyAt | type == "number") and
      (.agent2ReadyAt | type == "number") and
      .bankOpenCount == 2 and
      .planOperationCount == 2 and
      (.planOperations | length) == 2 and
      ([.planOperations[].agentId] | sort) ==
        ([$authority.agent1Id, $authority.agent2Id] | sort) and
      all(.planOperations[];
        (.committedInventory | type) == "array" and
        (.committedBank | type) == "array") and
      ([.activityRows[].agentId] | index($authority.agent1Id) != null) and
      ([.activityRows[].agentId] | index($authority.agent2Id) != null)
    ' <<<"$authority_state" >/dev/null; then
    echo "[e2e] full_3d private preparation authority did not match public truth" >&2
    jq -n \
      --argjson publicState "$public_state" \
      --argjson authorityState "${authority_state:-null}" \
      '{publicState: $publicState, authorityState: $authorityState}' >&2
    exit 1
  fi

  if [[ -z "$segment_path" || ! -s "$segment_path" ]]; then
    echo "[e2e] retained directed-preparation HLS segment is unavailable" >&2
    exit 1
  fi

  if [[ ! -s "$agent1_shot_frame_path" || ! -s "$agent2_shot_frame_path" ]]; then
    echo "[e2e] exact browser preparation frames are unavailable" >&2
    exit 1
  fi
  local agent1_shot_frame_dimensions
  local agent2_shot_frame_dimensions
  agent1_shot_frame_dimensions="$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height -of csv=s=x:p=0 \
    "$agent1_shot_frame_path")"
  agent2_shot_frame_dimensions="$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height -of csv=s=x:p=0 \
    "$agent2_shot_frame_path")"
  if [[ "$agent1_shot_frame_dimensions" != "1280x720" || \
    "$agent2_shot_frame_dimensions" != "1280x720" ]]; then
    echo "[e2e] exact browser preparation frames are not both 1280x720" >&2
    exit 1
  fi
  local agent1_shot_frame_sha256
  local agent2_shot_frame_sha256
  agent1_shot_frame_sha256="$(shasum -a 256 "$agent1_shot_frame_path" | awk '{print $1}')"
  agent2_shot_frame_sha256="$(shasum -a 256 "$agent2_shot_frame_path" | awk '{print $1}')"

  if ! ffmpeg -hide_banner -loglevel error -y \
    -i "$segment_path" -frames:v 1 \
    "$HYPERIA_PREPARATION_FRAME_FILE" || \
    [[ ! -s "$HYPERIA_PREPARATION_FRAME_FILE" ]]; then
    echo "[e2e] could not decode the public preparation HLS frame" >&2
    exit 1
  fi
  local frame_dimensions
  frame_dimensions="$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height -of csv=s=x:p=0 \
    "$HYPERIA_PREPARATION_FRAME_FILE")"
  if [[ "$frame_dimensions" != "1280x720" ]]; then
    echo "[e2e] public preparation frame was $frame_dimensions, expected 1280x720" >&2
    exit 1
  fi
  local frame_sha256
  frame_sha256="$(shasum -a 256 "$HYPERIA_PREPARATION_FRAME_FILE" | awk '{print $1}')"
  local segment_sha256
  segment_sha256="$(shasum -a 256 "$segment_path" | awk '{print $1}')"
  renderer_status="$retained_preparation_renderer_status"
  if ! jq -e '
    .source == "external-rtmp-bridge" and
    .rendererHealth.ready == true and
    .rendererHealth.degradedReason == null and
    .rendererHealth.phase == "IDLE" and
    .rendererHealth.diagnostics.sceneReadiness.ready == true and
    .rendererHealth.diagnostics.sceneReadiness.phase == "IDLE" and
    .rendererHealth.diagnostics.sceneReadiness.expectedAgentCount == 2 and
    .rendererHealth.diagnostics.sceneReadiness.loadedExpectedAgentCount == 2 and
    .rendererHealth.diagnostics.sceneReadiness.visibleExpectedAgentCount >= 1 and
    .rendererHealth.diagnostics.sceneReadiness.renderedAgentCount == 2 and
    .rendererHealth.diagnostics.sceneReadiness.preparationActive == true and
    .rendererHealth.diagnostics.sceneReadiness.preparationShotActive == true and
    .rendererHealth.diagnostics.sceneReadiness.croppedVisibleAgentBodyCount == 0 and
    .rendererHealth.diagnostics.sceneReadiness.occludedVisibleAgentBodyCount == 0 and
    .rendererHealth.diagnostics.sceneReadiness.missingVisibleAgentLineOfSightCount == 0 and
    .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentBodyNdcSpan >= 0.55 and
    .rendererHealth.diagnostics.sceneReadiness.maximumVisibleAgentBodyNdcSpan <= 0.75 and
    (if .rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == true then
      .rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 2 and
      (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent1") != null) and
      (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent2") != null) and
      (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent1") != null) and
      (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent2") != null) and
      .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation >= 0.24
     else
      .rendererHealth.diagnostics.sceneReadiness.cameraTargetMatchesExpected == true and
      ((.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent1" and
        (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent1") != null) and
        (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent1") != null)) or
       (.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent2" and
        (.rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots | index("agent2") != null) and
        (.rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots | index("agent2") != null))) and
      .rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 1 and
      .rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation == null
     end) and
    .stats.ffmpegRunning == true and
    .stats.audioSource == "browser" and
    .stats.audioHealthy == true and
    .stats.audioDroppedChunks == 0 and
    .stats.audioTrimmedChunks == 0 and
    .browserAudioCaptureHealth.contextState == "running" and
    .browserAudioCaptureHealth.sourceContextState == "running" and
    .browserAudioCaptureHealth.trackState == "live" and
    .browserAudioCaptureHealth.sampleRate == 48000 and
    .browserAudioCaptureHealth.channels == 2 and
    .browserAudioCaptureHealth.droppedChunks == 0 and
    .browserAudioCaptureHealth.pendingWrites == 0
  ' <<<"$renderer_status" >/dev/null; then
    echo "[e2e] renderer was not healthy in the exact public preparation frame" >&2
    local failure_artifact_dir
    failure_artifact_dir="$APP_DIR/test-results/hyperia-preparation-gate-failure-$captured_at_ms"
    mkdir -p "$failure_artifact_dir"
    cp "$HYPERIA_PREPARATION_FRAME_FILE" "$failure_artifact_dir/preparation-frame.png"
    printf '%s\n' "$renderer_status" > "$failure_artifact_dir/renderer-status.json"
    printf '%s\n' "$public_state" > "$failure_artifact_dir/public-state.json"
    printf '%s\n' "$authority_state" > "$failure_artifact_dir/private-authority.json"
    if [[ -f "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" ]]; then
      cp "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" \
        "$failure_artifact_dir/ordinary-preparation-evidence.json"
    fi
    if [[ -f "$HYPERIA_LOG" ]]; then
      cp "$HYPERIA_LOG" "$failure_artifact_dir/hyperia.log"
    fi
    chmod 600 "$failure_artifact_dir"/*
    echo "[e2e] retained preparation gate failure at $failure_artifact_dir" >&2
    jq '.' <<<"$renderer_status" >&2
    exit 1
  fi

  local ordinary_preparation_state="null"
  if [[ "$HYPERIA_ORDINARY_PREPARATION" == "true" ]]; then
    ordinary_preparation_state="$(<"$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE")"
    if ! jq -e \
      --argjson privateAuthority "$authority_state" \
      --argjson expectedMultiStyle "$HYPERIA_MULTI_STYLE" \
      --arg expectedCombatRole "$E2E_HYPERIA_COMBAT_ROLE" '
        .schemaVersion == 3 and
        .status == "passed" and
        .multiStyle == $expectedMultiStyle and
        .availableCombatRoles ==
          (if $expectedMultiStyle then ["melee", "ranged", "mage"] else [$expectedCombatRole] end) and
        ([.agents[].agentId] | sort) ==
          ([$privateAuthority.agent1Id, $privateAuthority.agent2Id] | sort) and
        ([.liveWorldReports[].agentId] | sort) ==
          ([$privateAuthority.agent1Id, $privateAuthority.agent2Id] | sort) and
        .totals.gatheringOperations >= 8 and
        .totals.processingOperations >= 8 and
        .totals.ordinaryBankOperations ==
          ([.agents[].ordinaryBankOperations] | add) and
        ([.agents[] as $agent |
          .liveWorldReports[] |
          select(.agentId == $agent.agentId) |
          (.preparationVerticalSlice.forging.actionCounts.bankDepositAll // 0) as $setupDeposits |
          ($setupDeposits == 0 or $setupDeposits == 1) and
          $agent.ordinaryBankOperations == (1 + $setupDeposits)] |
          length == 2 and all) and
        .livePreparationPresentationCovered == true and
        .fullTopologySeedContractCovered == true and
        .ownedMultiStylePreparationCovered == $expectedMultiStyle and
        .ordinaryForgingQuestCovered == $expectedMultiStyle and
        .externalModelProviderCovered == false
      ' <<<"$ordinary_preparation_state" >/dev/null; then
      echo "[e2e] ordinary preparation identities did not bind to private duel preparation" >&2
      exit 1
    fi
  fi

  jq -n \
    --argjson capturedAtMs "$captured_at_ms" \
    --argjson publicState "$public_state" \
    --argjson privateAuthority "$authority_state" \
    --argjson ordinaryPreparation "$ordinary_preparation_state" \
    --argjson rendererStatus "$renderer_status" \
    --argjson agent1ShotPublicState "$agent1_shot_public_state" \
    --argjson agent1ShotRendererStatus "$agent1_shot_renderer_status" \
    --argjson agent2ShotPublicState "$agent2_shot_public_state" \
    --argjson agent2ShotRendererStatus "$agent2_shot_renderer_status" \
    --arg agent1ShotFramePath "$agent1_shot_frame_path" \
    --arg agent1ShotFrameSha256 "$agent1_shot_frame_sha256" \
    --arg agent2ShotFramePath "$agent2_shot_frame_path" \
    --arg agent2ShotFrameSha256 "$agent2_shot_frame_sha256" \
    --arg framePath "$HYPERIA_PREPARATION_FRAME_FILE" \
    --arg frameSha256 "$frame_sha256" \
    --arg segmentName "$segment_name" \
    --arg segmentSha256 "$segment_sha256" \
    '{
      schemaVersion: 1,
      capturedAtMs: $capturedAtMs,
      publicState: $publicState,
      privateAuthority: $privateAuthority,
      ordinaryPreparation: $ordinaryPreparation,
      rendererStatus: $rendererStatus,
      preparationCoverage: {
        mode: (if $agent1ShotRendererStatus.rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == true and
                  $agent2ShotRendererStatus.rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == true
               then "pair" else "directed_cuts" end),
        shots: [
          {
            slot: "agent1",
            publicState: $agent1ShotPublicState,
            rendererStatus: $agent1ShotRendererStatus,
            frame: {
              source: "capture_browser",
              path: $agent1ShotFramePath,
              sha256: $agent1ShotFrameSha256,
              width: 1280,
              height: 720
            }
          },
          {
            slot: "agent2",
            publicState: $agent2ShotPublicState,
            rendererStatus: $agent2ShotRendererStatus,
            frame: {
              source: "capture_browser",
              path: $agent2ShotFramePath,
              sha256: $agent2ShotFrameSha256,
              width: 1280,
              height: 720
            }
          }
        ]
      },
      hls: {
        framePath: $framePath,
        frameSha256: $frameSha256,
        width: 1280,
        height: 720,
        segmentName: $segmentName,
        segmentSha256: $segmentSha256
      }
    }' >"$HYPERIA_PREPARATION_EVIDENCE_FILE"
  chmod 600 \
    "$HYPERIA_PREPARATION_EVIDENCE_FILE" \
    "$HYPERIA_PREPARATION_FRAME_FILE" \
    "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
    "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE"
  echo "[e2e] captured authoritative public 3D preparation before market publication"
}

start_real_hyperia_source() {
  if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" && "${E2E_SKIP_PREBUILD:-false}" == "true" ]]; then
    echo "[e2e] verifying reused competitive runtime before creating the launch database"
    (
      cd "$HYPERIA_ROOT"
      "$E2E_NODE_BIN" --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
import { verifyCompetitiveServerRuntime } from './packages/server/dist/competitiveServerBootstrap.js';
const buildId = verifyCompetitiveServerRuntime({
  serverModuleUrl: pathToFileURL(`${process.cwd()}/packages/server/dist/index.js`).href,
});
console.log(`[e2e] verified competitive build ${buildId}`);
NODE
    )
  fi
  echo "[e2e] starting persisted Hyperia duel-authority source ($E2E_HYPERIA_RUNTIME)"
  docker run --rm -d \
    --name "$HYPERIA_POSTGRES_CONTAINER" \
    -e "POSTGRES_USER=$HYPERIA_POSTGRES_USER" \
    -e "POSTGRES_PASSWORD=$HYPERIA_POSTGRES_PASSWORD" \
    -e "POSTGRES_DB=$HYPERIA_POSTGRES_DB" \
    -p 127.0.0.1::5432 \
    postgres:16-alpine >/dev/null
  if ! wait_for_hyperia_postgres; then
    echo "[e2e] Hyperia PostgreSQL did not become ready" >&2
    docker logs "$HYPERIA_POSTGRES_CONTAINER" 2>&1 | tail -n 80 || true
    exit 1
  fi

  local postgres_port
  postgres_port="$(docker port "$HYPERIA_POSTGRES_CONTAINER" 5432/tcp | awk -F: 'END {print $NF}')"
  if [[ ! "$postgres_port" =~ ^[1-9][0-9]*$ ]]; then
    echo "[e2e] could not resolve Hyperia PostgreSQL port" >&2
    exit 1
  fi
  local database_url="postgresql://${HYPERIA_POSTGRES_USER}:${HYPERIA_POSTGRES_PASSWORD}@127.0.0.1:${postgres_port}/${HYPERIA_POSTGRES_DB}"

  if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
    HLS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hyperbet-solana-e2e-hls.XXXXXX")"
    HLS_PRIMARY_URL="http://127.0.0.1:$APP_PORT/live/$HLS_PLAYLIST_FILE"
    HYPERIA_RENDERER_STATUS_FILE="$HLS_ROOT/rtmp-status.json"
    HYPERIA_CAPTURE_STATUS_FILE="$HLS_ROOT/capture-browser-status.json"
    echo "[e2e-hls] Hyperia production renderer/capture owns this HLS source" >"$HLS_LOG"

    write_env_file \
      "$HYPERIA_ENV_FILE" \
      NODE_ENV "production" \
      DUEL_NODE_ENV "production" \
      DUEL_HYPERIA_BUN_PATH "$HYPERIA_BUN_PATH" \
      DATABASE_URL "$database_url" \
      USE_LOCAL_POSTGRES "false" \
      POSTGRES_POOL_MAX "12" \
      POSTGRES_POOL_MIN "0" \
      JWT_SECRET "hyperia-sol-e2e-jwt-secret-full-3d" \
      SECRET_SALT "hyperia-sol-e2e-secret-salt-full-3d" \
      DISTRIBUTED_RATE_LIMIT_KEY_SECRET "hyperia-sol-e2e-rate-limit-secret-full-3d" \
      KILL_TOKEN_SECRET "hyperia-sol-e2e-kill-token-secret-full-3d" \
      ADMIN_CODE "$HYPERIA_ADMIN_CODE" \
      BETTING_FEED_ACCESS_TOKEN "$HYPERIA_BET_SYNC_TOKEN" \
      STREAMING_DUEL_SHUTDOWN_ACK_URL "$GAME_API_URL/api/keeper/bot-health" \
      STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS "15000" \
      DUEL_STACK_SHUTDOWN_GRACE_MS "19000" \
      STREAMING_VIEWER_ACCESS_TOKEN "hyperia-sol-e2e-viewer-token-full-3d" \
      CORS_ORIGINS "http://127.0.0.1:$HYPERIA_CLIENT_PORT" \
      DUEL_WITH_HYPERBET "false" \
      DUEL_BETTING_ENABLED "false" \
      DUEL_SERVER_AGENT_MODE "embedded" \
      AUTO_START_AGENTS "true" \
      AUTO_START_AGENTS_MAX "2" \
      SPAWN_MODEL_AGENTS "false" \
      MAX_MODEL_AGENTS "0" \
      SPAWN_MODEL_AGENTS_WITH_EMBEDDED "false" \
      STREAMING_DUEL_ENABLED "true" \
      STREAMING_DUEL_PREPARATION_MS "$HYPERIA_PREPARATION_MS" \
      STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS "$HYPERIA_PUBLIC_PREPARATION_MIN_MS" \
      STREAMING_PERSIST_STATS "false" \
      STREAMING_AGENT_SKIP_DB_LOAD "false" \
      STREAMING_DUEL_COMBAT_AI_ENABLED "true" \
      EMBEDDED_AGENT_DUEL_PREPARATION_LLM "false" \
      STREAMING_ANNOUNCEMENT_MS "$HYPERIA_ANNOUNCEMENT_MS" \
      STREAMING_COUNTDOWN_TICKS "3" \
      STREAMING_FIGHTING_MS "150000" \
      STREAMING_END_WARNING_MS "10000" \
      STREAMING_RESOLUTION_MS "$HYPERIA_RESOLUTION_MS" \
      HLS_OUTPUT_PATH "$HLS_ROOT/$HLS_PLAYLIST_FILE" \
      HLS_SEGMENT_PATTERN "$HLS_ROOT/segment-%09d.ts" \
      HLS_TIME_SECONDS "1" \
      HLS_LIST_SIZE "30" \
      HLS_DELETE_THRESHOLD "120" \
      HLS_FLAGS "delete_segments+append_list+independent_segments+program_date_time+omit_endlist+temp_file" \
      RTMP_STATUS_FILE "$HYPERIA_RENDERER_STATUS_FILE" \
      STREAM_CAPTURE_BROWSER_STATUS_FILE "$HYPERIA_CAPTURE_STATUS_FILE" \
      STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE" \
      STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE "$HYPERIA_CAPTURE_FRAME_STATUS_FILE" \
      STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY "$APP_DIR" \
      STREAM_CAPTURE_MODE "cdp" \
      STREAM_CAPTURE_CHANNEL "chrome" \
      STREAM_CAPTURE_ANGLE "metal" \
      STREAM_CAPTURE_HEADLESS "false" \
      STREAM_CAPTURE_WIDTH "1280" \
      STREAM_CAPTURE_HEIGHT "720" \
      STREAM_CAPTURE_FPS "30" \
      STREAM_BROWSER_AUDIO_REQUIRED "true" \
      DUEL_CAPTURE_BROWSER_HOST "true" \
      SPECTATOR_PORT "$HYPERIA_SPECTATOR_PORT" \
      DUEL_USE_PRODUCTION_CLIENT "true" \
      DUEL_STARTUP_TIMEOUT_MS "600000" \
      DUEL_STREAM_READY_TIMEOUT_MS "300000" \
      SKIP_CDN_MANIFEST_FETCH "true" \
      DATA_OPTIONAL_MANIFEST_WARNINGS "false" \
      DISABLE_RATE_LIMIT "true" \
      ALLOW_DESTRUCTIVE_CHANGES "false" \
      AGENT_DUEL_3D_E2E_DATABASE_URL "$database_url" \
      AGENT_DUEL_3D_E2E_ORDINARY_PREPARATION "$HYPERIA_ORDINARY_PREPARATION" \
      AGENT_DUEL_3D_E2E_MULTI_STYLE "$HYPERIA_MULTI_STYLE" \
      AGENT_DUEL_CYCLE_CHAOS_ROLE "$E2E_HYPERIA_COMBAT_ROLE"
    chmod 600 "$HYPERIA_ENV_FILE"

    echo "[e2e] seeding persistent non-diagnostic Hyperia contestants for the full 3D authority"
    if ! (
      cd "$HYPERIA_ROOT"
      set -a
      source "$HYPERIA_ENV_FILE"
      set +a
      "$HYPERIA_BUN_PATH" run packages/server/scripts/seed-agent-duel-3d-e2e.ts
    ) >>"$HYPERIA_LOG" 2>&1; then
      echo "[e2e] full_3d Hyperia contestant seed failed" >&2
      tail -n 160 "$HYPERIA_LOG" || true
      exit 1
    fi

    if [[ "$HYPERIA_ORDINARY_PREPARATION" == "true" ]]; then
      echo "[e2e] running ordinary physical gather/cook/bank preparation against the launch database"
      if ! (
        cd "$HYPERIA_ROOT"
        set -a
        source "$HYPERIA_ENV_FILE"
        set +a
        AGENT_PREPARATION_DUEL_EXISTING_DATABASE_URL="$database_url" \
          AGENT_PREPARATION_DUEL_EXISTING_EVIDENCE_FILE="$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" \
          "$HYPERIA_BUN_PATH" run \
            packages/server/scripts/test-agent-preparation-to-duel-combined.ts \
            --prepare-existing-database
      ) >>"$HYPERIA_LOG" 2>&1; then
        echo "[e2e] ordinary launch-database preparation failed" >&2
        tail -n 240 "$HYPERIA_LOG" || true
        exit 1
      fi
      if ! jq -e \
        --argjson expectedMultiStyle "$HYPERIA_MULTI_STYLE" \
        --arg expectedCombatRole "$E2E_HYPERIA_COMBAT_ROLE" '
        .schemaVersion == 3 and
        .status == "passed" and
        .multiStyle == $expectedMultiStyle and
        .availableCombatRoles ==
          (if $expectedMultiStyle then ["melee", "ranged", "mage"] else [$expectedCombatRole] end) and
        (.samePersistentAgentIds | length) == 2 and
        (.agents | length) == 2 and
        ([.agents[].agentId] | unique | length) == 2 and
        ([.agents[].cookedFood] | all(. >= 4)) and
        ([.agents[].toolCount] | all(. == 1)) and
        .totals.gatheringOperations >= 8 and
        .totals.processingOperations >= 8 and
        .totals.ordinaryBankOperations ==
          ([.agents[].ordinaryBankOperations] | add) and
        (.liveWorldReports | length) == 2 and
        ([.liveWorldReports[].preparationVerticalSlice.status] | all(. == "passed")) and
        ([.agents[] as $agent |
          .liveWorldReports[] |
          select(.agentId == $agent.agentId) |
          (.preparationVerticalSlice.forging.actionCounts.bankDepositAll // 0) as $setupDeposits |
          ($setupDeposits == 0 or $setupDeposits == 1) and
          $agent.ordinaryBankOperations == (1 + $setupDeposits)] |
          length == 2 and all) and
        .processDeathRecoveryCovered == true and
        .ordinaryAutonomySelectionCovered == true and
        .liveWorldNavigationCovered == true and
        .livePreparationPresentationCovered == true and
        .realPostgresqlCustodyCovered == true and
        .fullTopologySeedContractCovered == true and
        .ownedMultiStylePreparationCovered == $expectedMultiStyle and
        .ordinaryForgingQuestCovered == $expectedMultiStyle and
        .workerDatabaseSessionsDrained == true and
        (.workerDatabaseSessionDrainElapsedMs | type == "number" and . >= 0 and . <= 30000) and
        (.remainingWorkerDatabaseSessionPids | length) == 0 and
        .scriptedCustodyBridgeCovered == false and
        .externalModelProviderCovered == false and
        (if $expectedMultiStyle then
          ([.agents[].privateMultiStyleCustody |
            .meleeWeapon == 1 and
            .mageWeapon == 1 and
            .fireRunes > 0 and
            .mindRunes > 0] | all) and
          ([.agents[].ownedForgingAndCombatCustody |
            .shortbow == 1 and
            .bronzeArrows > 0 and
            .bronzeLongsword == 1 and
            .bronzeShortsword == 1 and
            .staffOfAir == 1 and
            .fireRunes > 0 and
            .mindRunes > 0 and
            .bronzeHatchet == 1 and
            .bronzePickaxe == 2 and
            .hammer == 1 and
            .xpLamp100 == 1] | all)
        else true end)
      ' "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" >/dev/null; then
        echo "[e2e] ordinary preparation evidence failed its launch gate" >&2
        jq '.' "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" >&2 || true
        exit 1
      fi
      chmod 600 "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE"
    fi

    if [[ "$E2E_HYPERIA_TERMINAL_EXPECTATION" == "exact_timeout" ]]; then
      echo "[e2e] installing the bounded production-valid timeout combat profile"
      if ! (
        cd "$HYPERIA_ROOT"
        set -a
        source "$HYPERIA_ENV_FILE"
        set +a
        AGENT_DUEL_3D_E2E_TIMEOUT_PROFILE="true" \
          "$HYPERIA_BUN_PATH" run \
            packages/server/scripts/configure-agent-duel-3d-timeout-e2e.ts
      ) >>"$HYPERIA_LOG" 2>&1; then
        echo "[e2e] timeout combat profile configuration failed" >&2
        tail -n 200 "$HYPERIA_LOG" || true
        exit 1
      fi
    elif [[ "$E2E_HYPERIA_TERMINAL_EXPECTATION" == "short_kill" ]]; then
      echo "[e2e] installing the bounded local short-kill combat profile"
      if ! (
        cd "$HYPERIA_ROOT"
        set -a
        source "$HYPERIA_ENV_FILE"
        set +a
        AGENT_DUEL_3D_E2E_SHORT_KILL_PROFILE="true" \
          "$HYPERIA_BUN_PATH" run \
            packages/server/scripts/configure-agent-duel-3d-short-kill-e2e.ts
      ) >>"$HYPERIA_LOG" 2>&1; then
        echo "[e2e] short-kill combat profile configuration failed" >&2
        tail -n 200 "$HYPERIA_LOG" || true
        exit 1
      fi
    fi

    # macOS Bash 3.2 treats an empty array expansion as unbound under `set -u`.
    # Keep the required isolation flag in the array so both build modes use the
    # same safe launch path and only artifact reuse remains conditional.
    local hyperia_build_args=(--isolated)
    if [[ "${E2E_SKIP_PREBUILD:-false}" == "true" ]]; then
      hyperia_build_args+=(--reuse-game-builds)
    fi

    (
      cd "$HYPERIA_ROOT"
      set -a
      source "$HYPERIA_ENV_FILE"
      set +a
      exec "$E2E_NODE_BIN" scripts/duel-stack.mjs \
        --server-url "$HYPERIA_URL" \
        --ws-url "ws://127.0.0.1:$HYPERIA_WS_PORT/ws" \
        --client-url "http://127.0.0.1:$HYPERIA_CLIENT_PORT" \
        --rtmp-port "$HYPERIA_RTMP_PORT" \
        --capture-browser-port "$HYPERIA_CAPTURE_BROWSER_PORT" \
        --skip-bots \
        --skip-betting \
        --skip-keeper \
        --local-smoke \
        "${hyperia_build_args[@]}"
    ) >>"$HYPERIA_LOG" 2>&1 &
    HYPERIA_PID="$!"
    write_pid_file "$HYPERIA_PID_FILE" "$HYPERIA_PID"

    if ! wait_for_app "$HYPERIA_URL/health" "$HYPERIA_STARTUP_WAIT_SECONDS" "$HYPERIA_PID"; then
      echo "[e2e] full_3d Hyperia server did not become ready" >&2
      tail -n 200 "$HYPERIA_LOG" || true
      exit 1
    fi
    local hyperia_browser_origin="http://127.0.0.1:$HYPERIA_CLIENT_PORT"
    local hyperia_betting_headers=""
    local hyperia_betting_cors_origin=""
    hyperia_betting_headers="$(
      curl -fsS \
        -H "Origin: $hyperia_browser_origin" \
        -D - \
        -o /dev/null \
        "$HYPERIA_URL/api/streaming/betting"
    )" || {
      echo "[e2e] public Hyperia betting presentation endpoint was not reachable from the capture origin" >&2
      tail -n 200 "$HYPERIA_LOG" || true
      exit 1
    }
    hyperia_betting_cors_origin="$(
      printf '%s\n' "$hyperia_betting_headers" |
        tr -d '\r' |
        awk -F ': ' 'tolower($1) == "access-control-allow-origin" { print $2; exit }'
    )"
    if [[ "$hyperia_betting_cors_origin" != "$hyperia_browser_origin" ]]; then
      echo "[e2e] public Hyperia betting presentation endpoint did not authorize the exact capture origin" >&2
      exit 1
    fi
    capture_full_3d_public_preparation
    local full_3d_ready="false"
    for _ in {1..600}; do
      if [[ -f "$HLS_ROOT/$HLS_PLAYLIST_FILE" ]] && \
        grep -q '#EXT-X-PROGRAM-DATE-TIME' "$HLS_ROOT/$HLS_PLAYLIST_FILE" && \
        grep -q '#EXTINF' "$HLS_ROOT/$HLS_PLAYLIST_FILE" && \
        [[ -f "$HYPERIA_RENDERER_STATUS_FILE" ]] && \
        jq -e '
          .source == "external-rtmp-bridge" and
          .rendererHealth.ready == true and
          .rendererHealth.degradedReason == null and
          .rendererHealth.phase == "ANNOUNCEMENT" and
          .rendererHealth.diagnostics.sceneReadiness.ready == true and
          .rendererHealth.diagnostics.sceneReadiness.phase == "ANNOUNCEMENT" and
          .rendererHealth.diagnostics.sceneReadiness.expectedAgentCount == 2 and
          .rendererHealth.diagnostics.sceneReadiness.equipmentConfigured == true and
          .rendererHealth.diagnostics.sceneReadiness.equipmentRequiredCount > 0 and
          .rendererHealth.diagnostics.sceneReadiness.equipmentRequiredPlayerCount == 2 and
          .rendererHealth.diagnostics.sceneReadiness.equipmentExpectedPlayerCount == 2 and
          .rendererHealth.diagnostics.sceneReadiness.equipmentReadyCount ==
            .rendererHealth.diagnostics.sceneReadiness.equipmentRequiredCount and
          .rendererHealth.diagnostics.sceneReadiness.equipmentUnresolvedCount == 0 and
          .rendererHealth.diagnostics.sceneReadiness.equipmentAttachmentMismatchCount == 0 and
          .stats.ffmpegRunning == true and
          .stats.audioSource == "browser" and
          .stats.audioHealthy == true and
          .stats.audioChunks > 0 and
          .stats.audioDroppedChunks == 0 and
          .stats.audioTrimmedChunks == 0 and
          .browserAudioCaptureHealth.contextState == "running" and
          .browserAudioCaptureHealth.sourceContextState == "running" and
          .browserAudioCaptureHealth.trackState == "live" and
          .browserAudioCaptureHealth.sampleRate == 48000 and
          .browserAudioCaptureHealth.channels == 2 and
          .browserAudioCaptureHealth.droppedChunks == 0 and
          .browserAudioCaptureHealth.pendingWrites == 0
        ' "$HYPERIA_RENDERER_STATUS_FILE" >/dev/null 2>&1; then
        full_3d_ready="true"
        break
      fi
      if [[ -f "$HYPERIA_RENDERER_STATUS_FILE" ]] && \
        jq -e '
          .rendererHealth.phase == "COUNTDOWN" or
          .rendererHealth.phase == "FIGHTING" or
          .rendererHealth.phase == "RESOLUTION"
        ' "$HYPERIA_RENDERER_STATUS_FILE" >/dev/null 2>&1; then
        echo "[e2e] full_3d source missed the open betting window before downstream startup" >&2
        local startup_failure_artifact_dir
        startup_failure_artifact_dir="$APP_DIR/test-results/hyperia-announcement-readiness-failure-$(date +%s000)"
        mkdir -p "$startup_failure_artifact_dir"
        cp "$HYPERIA_RENDERER_STATUS_FILE" \
          "$startup_failure_artifact_dir/renderer-status.json"
        curl -fsS "$HYPERIA_URL/api/streaming/state" \
          >"$startup_failure_artifact_dir/public-state.json" 2>/dev/null || true
        if [[ -f "$HYPERIA_PREPARATION_EVIDENCE_FILE" ]]; then
          cp "$HYPERIA_PREPARATION_EVIDENCE_FILE" \
            "$startup_failure_artifact_dir/preparation-evidence.json"
        fi
        if [[ -f "$HYPERIA_PREPARATION_FRAME_FILE" ]]; then
          cp "$HYPERIA_PREPARATION_FRAME_FILE" \
            "$startup_failure_artifact_dir/preparation-frame.png"
        fi
        if [[ -f "$HYPERIA_LOG" ]]; then
          cp "$HYPERIA_LOG" "$startup_failure_artifact_dir/hyperia.log"
        fi
        chmod 600 "$startup_failure_artifact_dir"/*
        echo "[e2e] retained announcement readiness failure at $startup_failure_artifact_dir" >&2
        jq '{
          source,
          updatedAt,
          rendererHealth,
          stats,
          browserAudioCaptureHealth,
          renderProfile
        }' "$HYPERIA_RENDERER_STATUS_FILE" >&2 || true
        exit 1
      fi
      if ! kill -0 "$HYPERIA_PID" >/dev/null 2>&1; then
        echo "[e2e] full_3d Hyperia stack exited before renderer readiness" >&2
        tail -n 240 "$HYPERIA_LOG" || true
        exit 1
      fi
      sleep 1
    done
    if [[ "$full_3d_ready" != "true" ]]; then
      echo "[e2e] full_3d Hyperia renderer/HLS did not become ready" >&2
      tail -n 240 "$HYPERIA_LOG" || true
      [[ -f "$HYPERIA_RENDERER_STATUS_FILE" ]] && jq '.' "$HYPERIA_RENDERER_STATUS_FILE" || true
      exit 1
    fi
    local frozen_betting_source_ready="false"
    local frozen_betting_source=""
    for _ in {1..90}; do
      frozen_betting_source="$(curl -fsS \
        -H "authorization: Bearer $HYPERIA_BET_SYNC_TOKEN" \
        "$HYPERIA_BET_SYNC_STATE_URL" 2>/dev/null || true)"
      if jq -e '.schemaVersion == 3 and .competitiveSnapshot.persisted == true and .competitiveSnapshot.diagnostic == false and .rendererHealth.ready == true' \
        <<<"$frozen_betting_source" >/dev/null 2>&1; then
        frozen_betting_source_ready="true"
        break
      fi
      sleep 1
    done
    if [[ "$frozen_betting_source_ready" != "true" ]]; then
      echo "[e2e] full_3d Hyperia betting source did not expose rendered non-diagnostic schema-v3 truth" >&2
      tail -n 200 "$HYPERIA_LOG" || true
      exit 1
    fi
    local preparation_evidence_temp="${HYPERIA_PREPARATION_EVIDENCE_FILE}.tmp"
    if ! jq \
      --argjson frozenBettingSource "$frozen_betting_source" \
      '. + {
        frozenBettingSource: {
          schemaVersion: $frozenBettingSource.schemaVersion,
          duelId: $frozenBettingSource.duelId,
          duelKey: $frozenBettingSource.duelKey,
          competitiveSnapshotVersion: $frozenBettingSource.competitiveSnapshotVersion,
          competitiveSnapshotDigest: $frozenBettingSource.competitiveSnapshotDigest,
          competitiveSnapshot: $frozenBettingSource.competitiveSnapshot
        }
      }' \
      "$HYPERIA_PREPARATION_EVIDENCE_FILE" >"$preparation_evidence_temp"; then
      rm -f "$preparation_evidence_temp"
      echo "[e2e] could not bind frozen betting truth to preparation evidence" >&2
      exit 1
    fi
    mv "$preparation_evidence_temp" "$HYPERIA_PREPARATION_EVIDENCE_FILE"
    chmod 600 "$HYPERIA_PREPARATION_EVIDENCE_FILE"
    echo "[e2e] full_3d Hyperia source and canonical HLS are ready"
    return 0
  fi

  write_env_file \
    "$HYPERIA_ENV_FILE" \
    NODE_ENV "development" \
    JWT_SECRET "hyperia-sol-e2e-jwt-secret" \
    SECRET_SALT "hyperia-sol-e2e-secret-salt" \
    AGENT_DUEL_BET_SYNC_DATABASE_URL "$database_url" \
    AGENT_DUEL_BET_SYNC_PORT "$HYPERIA_API_PORT" \
    BETTING_FEED_ACCESS_TOKEN "$HYPERIA_BET_SYNC_TOKEN" \
    AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_URL "$GAME_API_URL/api/keeper/bot-health" \
    AGENT_DUEL_BET_SYNC_SHUTDOWN_ACK_TIMEOUT_MS "15000" \
    AGENT_DUEL_BET_SYNC_NATURAL_TERMINAL "$HYPERIA_NATURAL_TERMINAL" \
    AGENT_DUEL_BET_SYNC_COMBAT_TIMEOUT_MS "300000" \
    STREAMING_DUEL_ENABLED "true" \
    STREAMING_DUEL_PREPARATION_MS "$HYPERIA_PREPARATION_MS" \
    STREAMING_PERSIST_STATS "false" \
    STREAMING_AGENT_SKIP_DB_LOAD "false" \
    STREAMING_DUEL_COMBAT_AI_ENABLED "true" \
    EMBEDDED_AGENT_DUEL_PREPARATION_LLM "false" \
    STREAMING_ANNOUNCEMENT_MS "$HYPERIA_ANNOUNCEMENT_MS" \
    STREAMING_COUNTDOWN_TICKS "3" \
    STREAMING_FIGHTING_MS "150000" \
    STREAMING_END_WARNING_MS "10000" \
    STREAMING_RESOLUTION_MS "$HYPERIA_RESOLUTION_MS"

  (
    cd "$HYPERIA_ROOT/packages/server"
    set -a
    source "$HYPERIA_ENV_FILE"
    set +a
    exec bun run service:agent-duel-bet-sync-e2e
  ) >"$HYPERIA_LOG" 2>&1 &
  HYPERIA_PID="$!"
  write_pid_file "$HYPERIA_PID_FILE" "$HYPERIA_PID"
  if ! wait_for_app "$HYPERIA_URL/health" "$HYPERIA_STARTUP_WAIT_SECONDS" "$HYPERIA_PID"; then
    echo "[e2e] persisted Hyperia duel-authority source did not become ready" >&2
    tail -n 160 "$HYPERIA_LOG" || true
    exit 1
  fi
  if ! curl -fsS \
    -H "authorization: Bearer $HYPERIA_BET_SYNC_TOKEN" \
    "$HYPERIA_BET_SYNC_STATE_URL" \
    | jq -e '.schemaVersion == 3 and .competitiveSnapshot.persisted == true and .competitiveSnapshot.diagnostic == false' \
    >/dev/null; then
    echo "[e2e] Hyperia betting source did not expose non-diagnostic schema-v3 truth" >&2
    tail -n 160 "$HYPERIA_LOG" || true
    exit 1
  fi
}

run_with_retries() {
  local label="$1"
  local attempts="$2"
  shift 2

  local attempt=1
  while (( attempt <= attempts )); do
    if "$@"; then
      return 0
    fi

    if (( attempt == attempts )); then
      echo "[e2e] ${label} failed after ${attempts} attempts"
      return 1
    fi

    echo "[e2e] ${label} failed, retrying (${attempt}/${attempts})"
    sleep 2
    attempt=$((attempt + 1))
  done
}

kill_listeners() {
  local port="$1"
  local pids=""

  if has_cmd lsof; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  elif has_cmd netstat; then
    pids="$(netstat -ano 2>/dev/null | awk -v p=":${port}" '$1=="TCP" && $2 ~ (p"$") && $4=="LISTENING" { print $5 }' | sort -u)"
  fi

  if [[ -n "$pids" ]]; then
    if [[ "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" == "true" || "$E2E_WAGER_AUTHORITY_MATRIX" == "true" ]]; then
      echo "[e2e] authority verification refuses occupied port :$port; choose unused test ports" >&2
      exit 1
    fi
    echo "[e2e] clearing existing listeners on :$port"
    for pid in $pids; do
      if has_cmd taskkill; then
        taskkill //PID "$pid" //F >/dev/null 2>&1 || true
      else
        kill "$pid" >/dev/null 2>&1 || true
      fi
    done
    sleep 1
  fi
}

if [[ "$E2E_WAGER_AUTHORITY_MATRIX" == "true" || "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" == "true" ]]; then
  echo "[e2e] typechecking the complete wager authority browser entry"
  bun run --cwd "$APP_DIR" typecheck:e2e:wager-authority
  if [[ -e "$LEDGER_DIR" || -e "$KEEPER_DB_PATH" || -e "${KEEPER_DB_PATH}-shm" || -e "${KEEPER_DB_PATH}-wal" ]]; then
    echo "[e2e] authority verification requires fresh ledger and keeper database paths" >&2
    exit 1
  fi
  for authority_pid_file in "$APP_PID_FILE" "$VALIDATOR_PID_FILE" "$SOLANA_PROXY_PID_FILE" "$KEEPER_PID_FILE" "$DUEL_BOT_PID_FILE" "$BET_SYNC_FEED_PID_FILE" "$HLS_PID_FILE" "$HLS_BACKUP_PID_FILE" "$HLS_PRIMARY_ORIGIN_PID_FILE" "$HLS_BACKUP_ORIGIN_PID_FILE" "$HYPERIA_PID_FILE"; do
    if [[ -e "$authority_pid_file" ]]; then
      echo "[e2e] authority verification refuses existing runtime ownership file: $authority_pid_file" >&2
      exit 1
    fi
  done
fi

kill_listeners "$APP_PORT"
kill_listeners "$GAME_API_PORT"
kill_listeners "$BET_SYNC_FEED_PORT"
if [[ "$E2E_DUEL_SOURCE" == "real_hyperia" ]]; then
  kill_listeners "$HYPERIA_API_PORT"
  if [[ "$E2E_HYPERIA_RUNTIME" == "full_3d" ]]; then
    kill_listeners "$HYPERIA_WS_PORT"
    kill_listeners "$HYPERIA_CLIENT_PORT"
    kill_listeners "$HYPERIA_RTMP_PORT"
    kill_listeners "$HYPERIA_CAPTURE_BROWSER_PORT"
    kill_listeners "$HYPERIA_SPECTATOR_PORT"
  fi
  docker rm -f "$HYPERIA_POSTGRES_CONTAINER" >/dev/null 2>&1 || true
fi
kill_listeners "$SOLANA_RPC_PORT"
kill_listeners "$SOLANA_WS_PORT"
kill_listeners "$SOLANA_FAUCET_PORT"
kill_listeners "$SOLANA_GOSSIP_PORT"
kill_listeners "$SOLANA_PROXY_PORT"
rm -f "$KEEPER_DB_PATH" "${KEEPER_DB_PATH}-shm" "${KEEPER_DB_PATH}-wal"
rm -f "$KEEPER_BOT_HEALTH_PATH" "$KEEPER_STREAM_STATE_PATH"
rm -f "$HYPERIA_LOG"
rm -f \
  "$APP_PID_FILE" \
  "$VALIDATOR_PID_FILE" \
  "$SOLANA_PROXY_PID_FILE" \
  "$KEEPER_PID_FILE" \
  "$DUEL_BOT_PID_FILE" \
  "$BET_SYNC_FEED_PID_FILE" \
  "$HLS_PID_FILE" \
  "$HLS_BACKUP_PID_FILE" \
  "$HLS_PRIMARY_ORIGIN_PID_FILE" \
  "$HLS_BACKUP_ORIGIN_PID_FILE" \
  "$HLS_PRIMARY_ORIGIN_ENV_FILE" \
  "$HLS_BACKUP_ORIGIN_ENV_FILE" \
  "$HYPERIA_PID_FILE" \
  "$HYPERIA_ENV_FILE" \
  "$HYPERIA_PREPARATION_EVIDENCE_FILE" \
  "$HYPERIA_PREPARATION_FRAME_FILE" \
  "$HYPERIA_PREPARATION_AGENT1_FRAME_FILE" \
  "$HYPERIA_PREPARATION_AGENT2_FRAME_FILE" \
  "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE" \
  "$HYPERIA_CAPTURE_FRAME_STATUS_FILE" \
  "$HYPERIA_ORDINARY_PREPARATION_EVIDENCE_FILE" \
  "$SOLANA_PROXY_ENV_FILE" \
  "$KEEPER_ENV_FILE" \
  "$DUEL_BOT_ENV_FILE" \
  "$SOLANA_PROXY_FAULT_CONTROL_PATH" \
  "$CONTROL_PATH"
rm -f "$APP_DIR"/.e2e-hyperia-ordinary-preparation-evidence-*-live-world.json

E2E_RUNTIME_OWNERSHIP_STARTED=1
if [[ "${E2E_SKIP_PREBUILD:-false}" != "true" ]]; then
  echo "[e2e] building anchor programs"
  if ! bun run --cwd "$ANCHOR_DIR" build >"$ANCHOR_BUILD_LOG" 2>&1; then
    echo "[e2e] anchor build failed"
    tail -n 200 "$ANCHOR_BUILD_LOG" || true
    exit 1
  fi
else
  echo "[e2e] skipping shared prebuild"
fi

if [[ "$E2E_DUEL_SOURCE" == "real_hyperia" ]]; then
  start_real_hyperia_source
fi

IDL_ORACLE_ID="$(jq -r '.address // .metadata.address // empty' "$ANCHOR_DIR/target/idl/fight_oracle.json" 2>/dev/null || true)"
IDL_DUEL_MARKET_ID="$(jq -r '.address // .metadata.address // empty' "$ANCHOR_DIR/target/idl/duel_market.json" 2>/dev/null || true)"
if [[ -n "$IDL_ORACLE_ID" && "$IDL_ORACLE_ID" != "null" ]]; then
  PROGRAM_ORACLE_ID="$IDL_ORACLE_ID"
fi
if [[ -n "$IDL_DUEL_MARKET_ID" && "$IDL_DUEL_MARKET_ID" != "null" ]]; then
  PROGRAM_DUEL_MARKET_ID="$IDL_DUEL_MARKET_ID"
fi

echo "[e2e] starting local validator"
rm -rf "$LEDGER_DIR"
VALIDATOR_PROGRAM_ARGS=(
  --upgradeable-program "$PROGRAM_ORACLE_ID" "$ANCHOR_DIR/target/deploy/fight_oracle.so" "$BOOTSTRAP_WALLET_PATH"
  --upgradeable-program "$PROGRAM_DUEL_MARKET_ID" "$ANCHOR_DIR/target/deploy/duel_market.so" "$BOOTSTRAP_WALLET_PATH"
)
solana-test-validator \
  --reset \
  --quiet \
  --rpc-port "$SOLANA_RPC_PORT" \
  --faucet-port "$SOLANA_FAUCET_PORT" \
  --gossip-port "$SOLANA_GOSSIP_PORT" \
  --dynamic-port-range "${SOLANA_DYNAMIC_PORT_START}-${SOLANA_DYNAMIC_PORT_END}" \
  --mint "$SOLANA_MINT_AUTHORITY" \
  --ledger "$LEDGER_DIR" \
  "${VALIDATOR_PROGRAM_ARGS[@]}" \
  >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID="$!"
write_pid_file "$VALIDATOR_PID_FILE" "$VALIDATOR_PID"

if ! wait_for_solana_rpc; then
  echo "[e2e] validator did not become ready"
  tail -n 80 "$VALIDATOR_LOG" || true
  exit 1
fi
if ! wait_for_solana_ws; then
  echo "[e2e] validator websocket did not become ready"
  tail -n 80 "$VALIDATOR_LOG" || true
  exit 1
fi
if ! wait_for_solana_block_production; then
  echo "[e2e] validator did not begin producing blocks"
  tail -n 80 "$VALIDATOR_LOG" || true
  exit 1
fi
sleep 5

echo "[e2e] starting local solana rpc proxy"
write_env_file \
  "$SOLANA_PROXY_ENV_FILE" \
  SOLANA_RPC_TARGET "$SOLANA_RPC_URL" \
  SOLANA_WS_TARGET "$SOLANA_WS_URL" \
  SOLANA_PROXY_PORT "$SOLANA_PROXY_PORT" \
  SOLANA_PROXY_E2E_FAULTS_ENABLED "true" \
  SOLANA_PROXY_E2E_FAULT_CONTROL_PATH "$SOLANA_PROXY_FAULT_CONTROL_PATH" \
  SOLANA_PROXY_E2E_FAULT_HOLD_MS "30000"
env \
  SOLANA_RPC_TARGET="$SOLANA_RPC_URL" \
  SOLANA_WS_TARGET="$SOLANA_WS_URL" \
  SOLANA_PROXY_PORT="$SOLANA_PROXY_PORT" \
  SOLANA_PROXY_E2E_FAULTS_ENABLED="true" \
  SOLANA_PROXY_E2E_FAULT_CONTROL_PATH="$SOLANA_PROXY_FAULT_CONTROL_PATH" \
  SOLANA_PROXY_E2E_FAULT_HOLD_MS="30000" \
  "$E2E_NODE_BIN" "$APP_DIR/scripts/solana-rpc-proxy.mjs" >"$SOLANA_PROXY_LOG" 2>&1 &
SOLANA_PROXY_PID="$!"
write_pid_file "$SOLANA_PROXY_PID_FILE" "$SOLANA_PROXY_PID"
disown "$SOLANA_PROXY_PID" 2>/dev/null || true

if ! wait_for_solana_proxy; then
  echo "[e2e] solana proxy did not become ready"
  tail -n 80 "$SOLANA_PROXY_LOG" || true
  exit 1
fi

echo "[e2e] seeding local solana state + writing .env.e2e"
run_with_retries \
  "solana e2e setup" \
  3 \
  env \
    E2E_SOLANA_RPC_URL="$SOLANA_RPC_URL" \
    E2E_SOLANA_WS_URL="$SOLANA_WS_URL" \
    E2E_BROWSER_SOLANA_RPC_URL="$SOLANA_PROXY_URL" \
    E2E_BROWSER_SOLANA_WS_URL="$SOLANA_PROXY_WS_URL" \
    E2E_SOLANA_BOOTSTRAP_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
    E2E_DUEL_SOURCE="$E2E_DUEL_SOURCE" \
    E2E_HYPERIA_BET_SYNC_STATE_URL="$HYPERIA_BET_SYNC_STATE_URL" \
    E2E_HYPERIA_BET_SYNC_BEARER_TOKEN="$HYPERIA_BET_SYNC_TOKEN" \
    E2E_REAL_HYPERIA_MIN_OPEN_WINDOW_MS="$REAL_HYPERIA_MIN_OPEN_WINDOW_MS" \
    "$E2E_NODE_BIN" --import tsx "$APP_DIR/tests/e2e/setup-localnet.ts"

echo "[e2e] starting keeper api on :$GAME_API_PORT"
write_env_file \
  "$KEEPER_ENV_FILE" \
  PORT "$GAME_API_PORT" \
  KEEPER_DB_PATH "$KEEPER_DB_PATH" \
  SOLANA_CLUSTER "localnet" \
  SOLANA_RPC_URL "$SOLANA_VERIFIER_PROXY_URL" \
  FIGHT_ORACLE_PROGRAM_ID "$PROGRAM_ORACLE_ID" \
  DUEL_MARKET_PROGRAM_ID "$PROGRAM_DUEL_MARKET_ID" \
  ARENA_EXTERNAL_BET_WRITE_KEY "$E2E_ARENA_WRITE_KEY" \
  STREAM_PUBLISH_KEY "$E2E_ARENA_WRITE_KEY"
KEEPER_SERVICE_ENV=(
  PORT="$GAME_API_PORT"
  KEEPER_DB_PATH="$KEEPER_DB_PATH"
  SOLANA_CLUSTER="localnet"
  SOLANA_RPC_URL="$SOLANA_VERIFIER_PROXY_URL"
  FIGHT_ORACLE_PROGRAM_ID="$PROGRAM_ORACLE_ID"
  DUEL_MARKET_PROGRAM_ID="$PROGRAM_DUEL_MARKET_ID"
  ARENA_EXTERNAL_BET_WRITE_KEY="$E2E_ARENA_WRITE_KEY"
  STREAM_PUBLISH_KEY="$E2E_ARENA_WRITE_KEY"
)
if [[ "$E2E_DUEL_SOURCE" == "synthetic_publish" ]]; then
  printf 'STREAM_STATE_HEARTBEAT_MS=%q\n' "1000" >>"$KEEPER_ENV_FILE"
  KEEPER_SERVICE_ENV+=(STREAM_STATE_HEARTBEAT_MS=1000)
else
  printf 'STREAM_STATE_SOURCE_URL=%q\n' \
    "$HYPERIA_URL/api/streaming/state" >>"$KEEPER_ENV_FILE"
  KEEPER_SERVICE_ENV+=(
    STREAM_STATE_SOURCE_URL="$HYPERIA_URL/api/streaming/state"
  )
fi
env "${KEEPER_SERVICE_ENV[@]}" \
  bun run --cwd "$KEEPER_DIR" service >"$KEEPER_LOG" 2>&1 &
KEEPER_PID="$!"
write_pid_file "$KEEPER_PID_FILE" "$KEEPER_PID"

if ! wait_for_app "$GAME_API_URL/status"; then
  echo "[e2e] keeper api did not become ready"
  tail -n 80 "$KEEPER_LOG" || true
  exit 1
fi

if [[ "$E2E_DUEL_SOURCE" == "synthetic_publish" ]]; then
  echo "[e2e] seeding keeper live api state"
  env \
    E2E_GAME_API_URL="$GAME_API_URL" \
    E2E_ARENA_WRITE_KEY="$E2E_ARENA_WRITE_KEY" \
    E2E_DUEL_SOURCE="$E2E_DUEL_SOURCE" \
    bun run "$APP_DIR/tests/e2e/seed-api-local.ts"

  echo "[e2e] starting canonical bet-sync feed adapter"
  env \
    E2E_BET_SYNC_FEED_PORT="$BET_SYNC_FEED_PORT" \
    E2E_STREAM_STATE_URL="$GAME_API_URL/api/streaming/state" \
    bun "$APP_DIR/scripts/e2e-bet-sync-feed.mjs" >"$BET_SYNC_FEED_LOG" 2>&1 &
  BET_SYNC_FEED_PID="$!"
  write_pid_file "$BET_SYNC_FEED_PID_FILE" "$BET_SYNC_FEED_PID"
  if ! wait_for_app "$BET_SYNC_FEED_URL/api/internal/bet-sync/state"; then
    echo "[e2e] canonical bet-sync feed adapter did not become ready"
    tail -n 80 "$BET_SYNC_FEED_LOG" || true
    exit 1
  fi
else
  BET_SYNC_FEED_URL="$HYPERIA_URL"
fi

echo "[e2e] starting dedicated duel keeper"
BET_SYNC_SOURCE_TOKEN=""
if [[ "$E2E_DUEL_SOURCE" == "real_hyperia" ]]; then
  BET_SYNC_SOURCE_TOKEN="$HYPERIA_BET_SYNC_TOKEN"
fi
write_env_file \
  "$DUEL_BOT_ENV_FILE" \
  BOT_LOOP "true" \
  BOT_POLL_SECONDS "1" \
  GAME_URL "$BET_SYNC_FEED_URL" \
  BET_SYNC_SOURCE_BEARER_TOKEN "$BET_SYNC_SOURCE_TOKEN" \
  KEEPER_DB_PATH "$KEEPER_DB_PATH" \
  SOLANA_CLUSTER "localnet" \
  SOLANA_RPC_URL "$SOLANA_PROXY_URL" \
  SOLANA_RPC_WS_URL "$SOLANA_PROXY_WS_URL" \
  FIGHT_ORACLE_PROGRAM_ID "$PROGRAM_ORACLE_ID" \
  DUEL_MARKET_PROGRAM_ID "$PROGRAM_DUEL_MARKET_ID" \
  KEEPER_FEE_PAYER_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  ORACLE_REPORTER_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  ORACLE_FINALIZER_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  ORACLE_CHALLENGER_WALLET "$SOLANA_MINT_AUTHORITY" \
  CLOB_MARKET_OPERATOR_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  MARKET_MAKER_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  ORACLE_CONFIG_AUTHORITY_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  CLOB_CONFIG_AUTHORITY_KEYPAIR "$BOOTSTRAP_WALLET_PATH" \
  SOLANA_ORACLE_DISPUTE_WINDOW_SECS "$E2E_ORACLE_DISPUTE_WINDOW_SECS" \
  TRADE_TREASURY_FEE_BPS "100" \
  TRADE_MARKET_MAKER_FEE_BPS "100" \
  WINNINGS_MARKET_MAKER_FEE_BPS "200" \
  TERMINAL_OPERATION_LEASE_MS "30000" \
  TERMINAL_RETRY_BASE_MS "1000" \
  TERMINAL_RETRY_MAX_MS "5000" \
  KEEPER_BOT_HEALTH_FILE "$KEEPER_BOT_HEALTH_PATH"
env \
  BOT_LOOP="true" \
  BOT_POLL_SECONDS="1" \
  GAME_URL="$BET_SYNC_FEED_URL" \
  BET_SYNC_SOURCE_BEARER_TOKEN="$BET_SYNC_SOURCE_TOKEN" \
  KEEPER_DB_PATH="$KEEPER_DB_PATH" \
  SOLANA_CLUSTER="localnet" \
  SOLANA_RPC_URL="$SOLANA_PROXY_URL" \
  SOLANA_RPC_WS_URL="$SOLANA_PROXY_WS_URL" \
  FIGHT_ORACLE_PROGRAM_ID="$PROGRAM_ORACLE_ID" \
  DUEL_MARKET_PROGRAM_ID="$PROGRAM_DUEL_MARKET_ID" \
  KEEPER_FEE_PAYER_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  ORACLE_REPORTER_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  ORACLE_FINALIZER_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  ORACLE_CHALLENGER_WALLET="$SOLANA_MINT_AUTHORITY" \
  CLOB_MARKET_OPERATOR_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  MARKET_MAKER_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  ORACLE_CONFIG_AUTHORITY_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  CLOB_CONFIG_AUTHORITY_KEYPAIR="$BOOTSTRAP_WALLET_PATH" \
  SOLANA_ORACLE_DISPUTE_WINDOW_SECS="$E2E_ORACLE_DISPUTE_WINDOW_SECS" \
  TRADE_TREASURY_FEE_BPS="100" \
  TRADE_MARKET_MAKER_FEE_BPS="100" \
  WINNINGS_MARKET_MAKER_FEE_BPS="200" \
  TERMINAL_OPERATION_LEASE_MS="30000" \
  TERMINAL_RETRY_BASE_MS="1000" \
  TERMINAL_RETRY_MAX_MS="5000" \
  KEEPER_BOT_HEALTH_FILE="$KEEPER_BOT_HEALTH_PATH" \
  bun run --cwd "$KEEPER_DIR" duel-bot >"$DUEL_BOT_LOG" 2>&1 &
DUEL_BOT_PID="$!"
write_pid_file "$DUEL_BOT_PID_FILE" "$DUEL_BOT_PID"
disown "$DUEL_BOT_PID" 2>/dev/null || true

if ! wait_for_app "$GAME_API_URL/api/keeper/bot-health"; then
  echo "[e2e] dedicated duel keeper did not become ready"
  curl -sS "$GAME_API_URL/api/keeper/bot-health" || true
  tail -n 120 "$DUEL_BOT_LOG" || true
  exit 1
fi

echo "[e2e] starting $E2E_APP_RUNTIME app on :$APP_PORT"
kill_listeners "$APP_PORT"
rm -rf "$APP_DIR/node_modules/.vite"
start_timestamped_test_hls
APP_VITE_ENV=(
  VITE_GAME_API_URL="$GAME_API_URL"
  VITE_HLS_ROOT="$HLS_ROOT"
  VITE_STREAM_URL="$HLS_PRIMARY_URL"
  VITE_TERMS_URL="${VITE_TERMS_URL:-/terms}"
  VITE_PRIVACY_URL="${VITE_PRIVACY_URL:-/privacy}"
  VITE_SOLANA_CLUSTER="localnet"
  VITE_SOLANA_RPC_URL="$SOLANA_PROXY_URL"
  VITE_SOLANA_WS_URL="$SOLANA_PROXY_WS_URL"
  VITE_USE_LOCAL_SOLANA_RPC_PROXY="true"
)
if [[ "$E2E_HLS_FAILOVER" == "true" ]]; then
  APP_VITE_ENV+=(
    VITE_STREAM_SOURCES="$HLS_PRIMARY_URL,$HLS_BACKUP_URL"
  )
fi
if [[ "$E2E_APP_RUNTIME" == "production_preview" ]]; then
  echo "[e2e] building production spectator app"
  if [[ "$E2E_PRODUCTION_TRANSACTIONS" == "true" ]]; then
    echo "[e2e] enabling local-only transaction authority in the production bundle"
    (
      cd "$APP_DIR"
      exec env \
        "${APP_VITE_ENV[@]}" \
        VITE_TRANSACTIONS_ENABLED="$E2E_PRODUCTION_TRANSACTIONS" \
        "$VITE_BIN" build --mode e2e
    ) >"$APP_LOG" 2>&1
    (
      cd "$APP_DIR"
      exec env \
        "${APP_VITE_ENV[@]}" \
        VITE_TRANSACTIONS_ENABLED="$E2E_PRODUCTION_TRANSACTIONS" \
        "$VITE_BIN" preview --mode e2e --port "$APP_PORT" --strictPort
    ) >>"$APP_LOG" 2>&1 &
  else
    (
      cd "$APP_DIR"
      exec env \
        "${APP_VITE_ENV[@]}" \
        VITE_TRANSACTIONS_ENABLED="$E2E_PRODUCTION_TRANSACTIONS" \
        "$VITE_BIN" build --mode production
    ) >"$APP_LOG" 2>&1
    (
      cd "$APP_DIR"
      exec env \
        "${APP_VITE_ENV[@]}" \
        VITE_TRANSACTIONS_ENABLED="$E2E_PRODUCTION_TRANSACTIONS" \
        "$VITE_BIN" preview --mode production --port "$APP_PORT" --strictPort
    ) >>"$APP_LOG" 2>&1 &
  fi
else
  echo "[e2e] pre-bundling vite dependencies"
  if ! (
    cd "$APP_DIR"
    env \
      "${APP_VITE_ENV[@]}" \
      "$VITE_BIN" optimize --force --mode e2e
  ) >/tmp/hyperbet-solana-e2e-vite-optimize.log 2>&1; then
    echo "[e2e] warning: vite optimize failed; continuing with dev server startup"
    tail -n 80 /tmp/hyperbet-solana-e2e-vite-optimize.log || true
  fi
  (
    cd "$APP_DIR"
    env \
      "${APP_VITE_ENV[@]}" \
      "$VITE_BIN" --mode e2e --port "$APP_PORT" --strictPort
  ) >"$APP_LOG" 2>&1 &
fi
APP_PID="$!"
write_pid_file "$APP_PID_FILE" "$APP_PID"

if ! wait_for_app "http://127.0.0.1:$APP_PORT/"; then
  echo "[e2e] app did not become ready"
  tail -n 80 "$APP_LOG" || true
  exit 1
fi
sleep 2

write_control_file

if (( E2E_BROWSER_AUDIT_HOLD_SECONDS > 0 )); then
  echo "[e2e] holding the local stack for browser audit (${E2E_BROWSER_AUDIT_HOLD_SECONDS}s maximum)"
  sleep "$E2E_BROWSER_AUDIT_HOLD_SECONDS"
fi

echo "[e2e] running playwright tests"
WAGER_AUTHORITY_REPORT_ARGS=()
if [[ "$E2E_WAGER_AUTHORITY_MATRIX" == "true" ]]; then
  PLAYWRIGHT_JSON_OUTPUT_FILE="$(mktemp "$APP_DIR/.e2e-wager-authority-report.XXXXXX")"
  export PLAYWRIGHT_JSON_OUTPUT_FILE
  echo "[e2e] wager authority report: $PLAYWRIGHT_JSON_OUTPUT_FILE"
  export E2E_PLAYWRIGHT_RETRIES=0
  WAGER_AUTHORITY_REPORT_ARGS=(--reporter=list,json --grep 'wager authority outage at (review|before-wallet|wallet|broadcast) preserves the exact signing boundary$')
elif [[ "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" == "true" ]]; then
  PLAYWRIGHT_JSON_OUTPUT_FILE="$(mktemp "$APP_DIR/.e2e-capture-wager-authority-report.XXXXXX")"
  export PLAYWRIGHT_JSON_OUTPUT_FILE
  echo "[e2e] capture wager authority report: $PLAYWRIGHT_JSON_OUTPUT_FILE"
  export E2E_PLAYWRIGHT_RETRIES=0
  WAGER_AUTHORITY_REPORT_ARGS=(--reporter=list,json --grep 'real capture outage at (wallet|broadcast) preserves the exact signing boundary$')
fi
PLAYWRIGHT_EXIT_CODE=0
if E2E_BASE_URL="http://127.0.0.1:$APP_PORT" \
  E2E_GAME_API_URL="$GAME_API_URL" \
  E2E_ARENA_WRITE_KEY="$E2E_ARENA_WRITE_KEY" \
  E2E_DUEL_SOURCE="$E2E_DUEL_SOURCE" \
  E2E_HYPERIA_RUNTIME="$E2E_HYPERIA_RUNTIME" \
  E2E_HYPERIA_COMBAT_ROLE="$E2E_HYPERIA_COMBAT_ROLE" \
  E2E_HYPERIA_NATURAL_TERMINAL="$HYPERIA_NATURAL_TERMINAL" \
  E2E_HYPERIA_TERMINAL_EXPECTATION="$E2E_HYPERIA_TERMINAL_EXPECTATION" \
  E2E_HYPERIA_BET_SYNC_BEARER_TOKEN="$HYPERIA_BET_SYNC_TOKEN" \
  E2E_HYPERIA_ADMIN_CODE="$HYPERIA_ADMIN_CODE" \
  E2E_HYPERIA_PREPARATION_EVIDENCE_PATH="$HYPERIA_PREPARATION_EVIDENCE_FILE" \
  E2E_HYPERIA_PREPARATION_FRAME_PATH="$HYPERIA_PREPARATION_FRAME_FILE" \
  E2E_APP_RUNTIME="$E2E_APP_RUNTIME" \
  E2E_PERFORMANCE_PROFILE="$E2E_PERFORMANCE_PROFILE" \
  E2E_HLS_ADAPTIVE="$E2E_HLS_ADAPTIVE" \
  E2E_HLS_FAILOVER="$E2E_HLS_FAILOVER" \
  E2E_HLS_SOURCE_TOPOLOGY="${E2E_HLS_SOURCE_TOPOLOGY:-independent-encoders-origins}" \
  E2E_HLS_PRIMARY_URL="$HLS_PRIMARY_URL" \
  E2E_HLS_BACKUP_URL="$HLS_BACKUP_URL" \
  E2E_HLS_PRIMARY_ENCODER_PID="$HLS_PID" \
  E2E_HLS_BACKUP_ENCODER_PID="$HLS_BACKUP_PID" \
  E2E_HLS_PRIMARY_ORIGIN_PID="$HLS_PRIMARY_ORIGIN_PID" \
  E2E_HLS_BACKUP_ORIGIN_PID="$HLS_BACKUP_ORIGIN_PID" \
  E2E_HLS_PRIMARY_ORIGIN_PID_FILE="$HLS_PRIMARY_ORIGIN_PID_FILE" \
  E2E_HLS_BACKUP_ORIGIN_PID_FILE="$HLS_BACKUP_ORIGIN_PID_FILE" \
  E2E_HLS_CONTENT_PARITY_PATH="$HLS_CONTENT_PARITY_PATH" \
  E2E_PROCESS_CONTROL_SCRIPT="$REPO_ROOT/scripts/e2e-process-control.sh" \
  E2E_CONTROL_PATH="$CONTROL_PATH" \
  E2E_REQUIRE_MATURED_SOLANA_WIN_CLAIM="${E2E_REQUIRE_MATURED_SOLANA_WIN_CLAIM:-true}" \
    "$APP_DIR/node_modules/.bin/playwright" test \
      --config "$APP_DIR/tests/e2e/playwright.config.ts" "$@" ${WAGER_AUTHORITY_REPORT_ARGS[@]+"${WAGER_AUTHORITY_REPORT_ARGS[@]}"}; then
  PLAYWRIGHT_EXIT_CODE=0
else
  PLAYWRIGHT_EXIT_CODE="$?"
fi

if [[ "$PLAYWRIGHT_EXIT_CODE" == "0" && ( "$E2E_WAGER_AUTHORITY_MATRIX" == "true" || "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" == "true" ) ]]; then
  if ! "$E2E_NODE_BIN" --import tsx --input-type=module - "$PLAYWRIGHT_JSON_OUTPUT_FILE" "$APP_DIR/tests/e2e/wagerAuthorityEvidence.ts" "$E2E_CAPTURE_WAGER_AUTHORITY_MATRIX" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const policy = await import(pathToFileURL(process.argv[3]).href);
const realCapture = process.argv[4] === 'true';
const validate = realCapture ? policy.assertCaptureWagerAuthorityBrowserReport : policy.assertWagerAuthorityBrowserReport;
validate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
console.log(`[e2e] all ${realCapture ? 'two actual capture' : 'four synthetic'} wager authority stages passed exactly once, without skips or retries`);
NODE
  then
    PLAYWRIGHT_EXIT_CODE=1
  fi
fi

exit "$PLAYWRIGHT_EXIT_CODE"
