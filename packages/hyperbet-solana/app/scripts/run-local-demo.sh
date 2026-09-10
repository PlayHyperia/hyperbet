#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="$(cd "$APP_DIR/.." && pwd)"
ANCHOR_DIR="$DEMO_DIR/anchor"
SOLANA_ACTIVE_RELEASE_BIN="${SOLANA_ACTIVE_RELEASE_BIN:-$HOME/.local/share/solana/install/active_release/bin}"
if [[ -d "$SOLANA_ACTIVE_RELEASE_BIN" ]]; then
  export PATH="$SOLANA_ACTIVE_RELEASE_BIN:$PATH"
fi
LOCAL_DEMO_OWNS_CARGO_TARGET=0
CARGO_TARGET_DIR="${LOCAL_DEMO_CARGO_TARGET_DIR:-}"
if [[ -z "$CARGO_TARGET_DIR" ]]; then
  CARGO_TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hyperbet-solana-local-demo-cargo.XXXXXX")"
  LOCAL_DEMO_OWNS_CARGO_TARGET=1
fi
export CARGO_TARGET_DIR
LEDGER_DIR="$ANCHOR_DIR/.local-demo-ledger"
VALIDATOR_LOG="$APP_DIR/.local-demo-validator.log"
PROGRAM_ORACLE_ID="FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu"
PROGRAM_DUEL_MARKET_ID="7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG"
APP_PORT="${APP_PORT:-4179}"
RPC_URL="http://127.0.0.1:8899"
WALLET_PATH=""

VALIDATOR_PID=""

cleanup_cargo_target() {
  if [[ "$LOCAL_DEMO_OWNS_CARGO_TARGET" != "1" || ! -d "$CARGO_TARGET_DIR" ]]; then
    return 0
  fi
  case "$(basename "$CARGO_TARGET_DIR")" in
    hyperbet-solana-local-demo-cargo.*)
      rm -rf -- "$CARGO_TARGET_DIR"
      ;;
    *)
      echo "[local-demo] refusing to remove unexpected Cargo temp path: $CARGO_TARGET_DIR" >&2
      ;;
  esac
}

for required_solana_command in solana-keygen solana-test-validator; do
  if ! command -v "$required_solana_command" >/dev/null 2>&1; then
    echo "[local-demo] missing $required_solana_command; set SOLANA_ACTIVE_RELEASE_BIN to the pinned Solana CLI bin directory" >&2
    exit 1
  fi
done

cleanup() {
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" >/dev/null 2>&1; then
    kill "$VALIDATOR_PID" >/dev/null 2>&1 || true
    wait "$VALIDATOR_PID" >/dev/null 2>&1 || true
  fi
  cleanup_cargo_target
}
trap cleanup EXIT

resolve_wallet_path() {
  local candidates=()

  if [[ -n "${ANCHOR_WALLET:-}" ]]; then
    candidates+=("${ANCHOR_WALLET}")
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

  echo "[local-demo] no Anchor wallet found for upgradeable local validator" >&2
  exit 1
}

wait_for_rpc() {
  for _ in {1..90}; do
    if curl -s -X POST "$RPC_URL" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"result":"ok"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

kill_listeners() {
  local port="$1"
  local attempt
  for attempt in {1..10}; do
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
    if [[ -z "$pids" ]]; then
      return 0
    fi
    if [[ "$attempt" -eq 1 ]]; then
      echo "[local-demo] clearing existing listeners on :$port"
    fi
    for pid in $pids; do
      if [[ "$attempt" -lt 4 ]]; then
        kill "$pid" >/dev/null 2>&1 || true
      else
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    done
    sleep 1
  done

  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[local-demo] failed to clear listener on :$port" >&2
    exit 1
  fi
}

kill_listeners "$APP_PORT"
kill_listeners 8899

echo "[local-demo] building anchor programs"
bun run --cwd "$ANCHOR_DIR" build >/tmp/hyperbet-solana-local-build.log 2>&1

IDL_ORACLE_ID="$(jq -r '.address // .metadata.address // empty' "$ANCHOR_DIR/target/idl/fight_oracle.json" 2>/dev/null || true)"
IDL_DUEL_MARKET_ID="$(jq -r '.address // .metadata.address // empty' "$ANCHOR_DIR/target/idl/duel_market.json" 2>/dev/null || true)"
if [[ -n "$IDL_ORACLE_ID" && "$IDL_ORACLE_ID" != "null" ]]; then
  PROGRAM_ORACLE_ID="$IDL_ORACLE_ID"
fi
if [[ -n "$IDL_DUEL_MARKET_ID" && "$IDL_DUEL_MARKET_ID" != "null" ]]; then
  PROGRAM_DUEL_MARKET_ID="$IDL_DUEL_MARKET_ID"
fi
WALLET_PATH="$(resolve_wallet_path)"

echo "[local-demo] starting local validator"
rm -rf "$LEDGER_DIR"
solana-test-validator \
  --reset \
  --quiet \
  --ledger "$LEDGER_DIR" \
  --upgradeable-program "$PROGRAM_ORACLE_ID" "$ANCHOR_DIR/target/deploy/fight_oracle.so" "$WALLET_PATH" \
  --upgradeable-program "$PROGRAM_DUEL_MARKET_ID" "$ANCHOR_DIR/target/deploy/duel_market.so" "$WALLET_PATH" \
  >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID="$!"

if ! wait_for_rpc; then
  echo "[local-demo] validator did not become ready"
  tail -n 120 "$VALIDATOR_LOG" || true
  exit 1
fi

echo "[local-demo] seeding local state + writing app/.env.e2e"
bun run "$APP_DIR/tests/e2e/setup-localnet.ts" >/tmp/hyperbet-solana-local-seed.log

echo "[local-demo] starting app at http://127.0.0.1:$APP_PORT"
echo "[local-demo] validator log: $VALIDATOR_LOG"
VITE_HEADLESS_WALLET_AUTO_CONNECT=false \
  bun run --cwd "$APP_DIR" dev --mode e2e --port "$APP_PORT"
