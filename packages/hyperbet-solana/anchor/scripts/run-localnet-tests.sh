#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLANA_ACTIVE_RELEASE_BIN="${SOLANA_ACTIVE_RELEASE_BIN:-$HOME/.local/share/solana/install/active_release/bin}"
if [[ -d "$SOLANA_ACTIVE_RELEASE_BIN" ]]; then
  export PATH="$SOLANA_ACTIVE_RELEASE_BIN:$PATH"
fi
LEDGER_DIR="${ANCHOR_TEST_LEDGER_DIR:-$ROOT_DIR/.anchor/manual-test-ledger}"
VALIDATOR_LOG="${ANCHOR_TEST_VALIDATOR_LOG:-/tmp/hyperia-anchor-validator.log}"
BUILD_LOG="${ANCHOR_TEST_BUILD_LOG:-/tmp/hyperia-anchor-build.log}"
TEST_LOG="${ANCHOR_TEST_LOG:-/tmp/hyperia-anchor-localnet-test.log}"
RPC_PORT="${ANCHOR_TEST_RPC_PORT:-8899}"
WS_PORT="${ANCHOR_TEST_WS_PORT:-8900}"
FAUCET_PORT="${ANCHOR_TEST_FAUCET_PORT:-9900}"
MAX_ORACLE_STALENESS_SECONDS="${HYPERIA_MAX_ORACLE_STALENESS_SECONDS:-5}"
VALIDATOR_PID=""
TEST_DESCRIPTORS=("$@")
MOCHA_TIMEOUT_MS="${ANCHOR_TEST_MOCHA_TIMEOUT_MS:-1000000}"
MOCHA_GREP="${ANCHOR_TEST_MOCHA_GREP:-}"
MOCHA_BAIL="${ANCHOR_TEST_MOCHA_BAIL:-1}"
NODE_BIN="${ANCHOR_TEST_NODE_BIN:-node}"
MATRIX_TMP_DIR=""

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

  printf 'No Anchor wallet found. Checked:\n' >&2
  printf '  %s\n' "${candidates[@]}" >&2
  exit 1
}

resolve_program_id() {
  local program_name="$1"
  local fallback="$2"
  local idl_path="$ROOT_DIR/target/idl/${program_name}.json"

  if [[ -f "$idl_path" ]]; then
    local idl_program_id
    idl_program_id="$(jq -r '.address // .metadata.address // empty' "$idl_path")"
    if [[ -n "$idl_program_id" && "$idl_program_id" != "null" ]]; then
      printf '%s\n' "$idl_program_id"
      return 0
    fi
  fi

  printf '%s\n' "$fallback"
}

resolve_mint_authority() {
  local wallet_path="$1"

  if [[ -n "${ANCHOR_TEST_MINT_AUTHORITY:-}" ]]; then
    printf '%s\n' "${ANCHOR_TEST_MINT_AUTHORITY}"
    return 0
  fi

  if ! command -v solana-keygen >/dev/null 2>&1; then
    printf 'Missing required command: solana-keygen\n' >&2
    exit 1
  fi

  solana-keygen pubkey "$wallet_path"
}

kill_stale_validator_listener() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"

  if [[ -z "$pids" ]]; then
    return 0
  fi

  for pid in $pids; do
    local command_line
    command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == *"solana-test-validator"* ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    else
      printf 'Port %s is occupied by a non-validator process: %s\n' "$port" "$command_line" >&2
      exit 1
    fi
  done
}

kill_stale_validator_processes() {
  local pids
  pids="$(ps -Ao pid=,command= | awk -v root="$ROOT_DIR" '$0 ~ /solana-test-validator/ && $0 ~ (root "/target/deploy/fight_oracle.so") {print $1}')"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  for pid in $pids; do
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "[anchor-test] stopping stale validator process $pid"
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
}

wait_for_rpc() {
  local rpc_url="$1"
  for _ in {1..180}; do
    if curl -s -X POST "$rpc_url" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | rg -q '"result":"ok"'; then
      sleep 1
      return 0
    fi
    sleep 1
  done

  return 1
}

wait_for_program() {
  local rpc_url="$1"
  local program_id="$2"

  for _ in {1..180}; do
    if curl -s -X POST "$rpc_url" \
      -H "content-type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"${program_id}\",{\"encoding\":\"base64\"}]}" \
      | jq -e '.result.value != null and .result.value.executable == true' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

stop_validator() {
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" >/dev/null 2>&1; then
    kill "$VALIDATOR_PID" >/dev/null 2>&1 || true
    wait "$VALIDATOR_PID" >/dev/null 2>&1 || true
  fi
  VALIDATOR_PID=""
}

cleanup() {
  stop_validator
  if [[ -n "$MATRIX_TMP_DIR" && -d "$MATRIX_TMP_DIR" ]]; then
    rm -rf "$MATRIX_TMP_DIR"
  fi
}

trap cleanup EXIT

cd "$ROOT_DIR"

kill_stale_validator_processes

if [[ "${ANCHOR_MANUAL_TEST_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[anchor-test] building canonical pinned workspace artifacts"
  bash "$ROOT_DIR/scripts/build-workspace.sh" >"$BUILD_LOG" 2>&1
fi

for required in solana-test-validator curl jq lsof rg; do
  if ! command -v "$required" >/dev/null 2>&1; then
    # GitHub runners used by the generic CI workflow do not ship with Solana CLI.
    # Keep localnet tests mandatory outside CI, but skip them when the validator
    # binary is unavailable in CI so the package does not hard-fail the matrix.
    if [[ "$required" == "solana-test-validator" ]] && [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
      printf '[anchor-test] Missing %s in CI, skipping localnet suite\n' "$required"
      exit 0
    fi
    printf 'Missing required command: %s\n' "$required" >&2
    exit 1
  fi
done

TS_MOCHA_ENTRY="$ROOT_DIR/node_modules/ts-mocha/bin/ts-mocha"
MOCHA_PACKAGE="$ROOT_DIR/node_modules/mocha/package.json"
if [[ ! -f "$TS_MOCHA_ENTRY" || ! -f "$MOCHA_PACKAGE" ]]; then
  TS_MOCHA_ENTRY="$ROOT_DIR/../../../node_modules/ts-mocha/bin/ts-mocha"
  MOCHA_PACKAGE="$ROOT_DIR/../../../node_modules/mocha/package.json"
fi
if [[ -f "$TS_MOCHA_ENTRY" && -f "$MOCHA_PACKAGE" ]]; then
  TS_MOCHA_COMMAND=("$NODE_BIN" "$TS_MOCHA_ENTRY")
elif command -v bunx >/dev/null 2>&1; then
  WORKSPACE_NODE_MODULES="$ROOT_DIR/../../../node_modules"
  if [[ -d "$WORKSPACE_NODE_MODULES" ]]; then
    export NODE_PATH="$WORKSPACE_NODE_MODULES${NODE_PATH:+:$NODE_PATH}"
  fi
  TS_MOCHA_COMMAND=(bunx "ts-mocha@10.0.0")
else
  printf 'Missing ts-mocha binary and bunx fallback\n' >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/target/deploy/fight_oracle.so" || ! -f "$ROOT_DIR/target/deploy/duel_market.so" ]]; then
  printf 'Missing one or more deploy artifacts under %s\n' "$ROOT_DIR/target/deploy" >&2
  exit 1
fi

if [[ "$MOCHA_BAIL" != "0" && "$MOCHA_BAIL" != "1" ]]; then
  printf 'ANCHOR_TEST_MOCHA_BAIL must be 0 or 1, received: %s\n' "$MOCHA_BAIL" >&2
  exit 1
fi

if [[ ${#TEST_DESCRIPTORS[@]} -eq 0 ]]; then
  TEST_DESCRIPTORS=(
    tests/hyperbet.ts
    tests/duel_market.anchor.ts::each
    tests/duel_market_generalized.anchor.ts
    tests/duel_market_continuation.anchor.ts
    tests/duel_market_generated_continuation.anchor.ts
    tests/duel_market_security.ts
    tests/signed-bet-verification.anchor.ts
    tests/oracle-finality.anchor.ts
    tests/oracle_invariants.ts
  )
fi

WALLET_PATH="$(resolve_wallet_path)"
MINT_AUTHORITY="$(resolve_mint_authority "$WALLET_PATH")"
PROGRAM_ORACLE_ID="$(resolve_program_id fight_oracle FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu)"
PROGRAM_CLOB_ID="$(resolve_program_id duel_market 7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG)"

: >"$TEST_LOG"

TEST_TARGETS=()
TEST_GREPS=()
TEST_LABELS=()

escape_mocha_title() {
  "$NODE_BIN" -e 'const value = process.argv[1]; process.stdout.write(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);' "$1"
}

for test_descriptor in "${TEST_DESCRIPTORS[@]}"; do
  if [[ "$test_descriptor" != *"::each" ]]; then
    TEST_TARGETS+=("$test_descriptor")
    TEST_GREPS+=("$MOCHA_GREP")
    TEST_LABELS+=("$test_descriptor")
    continue
  fi

  if [[ -n "$MOCHA_GREP" ]]; then
    printf 'ANCHOR_TEST_MOCHA_GREP cannot be combined with an ::each target: %s\n' "$test_descriptor" >&2
    exit 1
  fi

  test_target="${test_descriptor%::each}"
  if [[ -z "$test_target" || "$test_target" == "$test_descriptor" ]]; then
    printf 'Invalid isolated test descriptor: %s\n' "$test_descriptor" >&2
    exit 1
  fi

  if [[ -z "$MATRIX_TMP_DIR" ]]; then
    MATRIX_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hyperbet-anchor-matrix.XXXXXX")"
  fi
  test_manifest="$MATRIX_TMP_DIR/$(printf '%s' "$test_target" | shasum -a 256 | cut -d ' ' -f 1).json"

  echo "[anchor-test] enumerating isolated tests for $test_target"
  if ! ANCHOR_PROVIDER_URL="http://127.0.0.1:1" \
    ANCHOR_WS_URL="ws://127.0.0.1:2" \
    ANCHOR_WALLET="$WALLET_PATH" \
    HYPERIA_MAX_ORACLE_STALENESS_SECONDS="$MAX_ORACLE_STALENESS_SECONDS" \
      "${TS_MOCHA_COMMAND[@]}" \
        -p ./tsconfig.json \
        -t "$MOCHA_TIMEOUT_MS" \
        --dry-run \
        --reporter json \
        "$test_target" >"$test_manifest"; then
    printf 'Failed to enumerate isolated tests for %s\n' "$test_target" >&2
    exit 1
  fi

  if ! jq -e '
    (.tests | length) > 0 and
    ([.tests[].fullTitle] | all(type == "string" and length > 0 and (contains("\n") | not))) and
    ([.tests[].fullTitle] | length) == ([.tests[].fullTitle] | unique | length)
  ' "$test_manifest" >/dev/null; then
    printf 'Isolated test manifest is empty, malformed, or contains duplicate titles: %s\n' "$test_target" >&2
    exit 1
  fi

  isolated_count="$(jq -r '.tests | length' "$test_manifest")"
  isolated_index=0
  while IFS= read -r full_title; do
    isolated_index=$((isolated_index + 1))
    TEST_TARGETS+=("$test_target")
    TEST_GREPS+=("$(escape_mocha_title "$full_title")")
    TEST_LABELS+=("$test_target [$isolated_index/$isolated_count] $full_title")
  done < <(jq -r '.tests[].fullTitle' "$test_manifest")
  echo "[anchor-test] expanded $test_target into $isolated_count fresh-validator tests"
done

test_index=0
for test_target in "${TEST_TARGETS[@]}"; do
  test_grep="${TEST_GREPS[$test_index]}"
  test_label="${TEST_LABELS[$test_index]}"
  current_rpc_port=$((RPC_PORT + test_index))
  current_ws_port=$((WS_PORT + test_index))
  current_faucet_port=$((FAUCET_PORT + test_index))
  current_rpc_url="http://127.0.0.1:${current_rpc_port}"
  current_ws_url="ws://127.0.0.1:${current_ws_port}"

  kill_stale_validator_listener "$current_rpc_port"
  kill_stale_validator_listener "$current_ws_port"
  kill_stale_validator_listener "$current_faucet_port"

  rm -rf "$LEDGER_DIR"
  mkdir -p "$(dirname "$LEDGER_DIR")"

  echo "[anchor-test] starting local validator for $test_label"
  solana-test-validator \
    --reset \
    --quiet \
    --rpc-port "$current_rpc_port" \
    --faucet-port "$current_faucet_port" \
    --mint "$MINT_AUTHORITY" \
    --ledger "$LEDGER_DIR" \
    --upgradeable-program "$PROGRAM_ORACLE_ID" "$ROOT_DIR/target/deploy/fight_oracle.so" "$WALLET_PATH" \
    --upgradeable-program "$PROGRAM_CLOB_ID" "$ROOT_DIR/target/deploy/duel_market.so" "$WALLET_PATH" \
    >"$VALIDATOR_LOG" 2>&1 &
  VALIDATOR_PID="$!"

  if ! wait_for_rpc "$current_rpc_url"; then
    echo "[anchor-test] validator did not become ready" >&2
    tail -n 120 "$VALIDATOR_LOG" >&2 || true
    exit 1
  fi

  for program_id in "$PROGRAM_ORACLE_ID" "$PROGRAM_CLOB_ID"; do
    if ! wait_for_program "$current_rpc_url" "$program_id"; then
      echo "[anchor-test] program $program_id did not become executable" >&2
      tail -n 120 "$VALIDATOR_LOG" >&2 || true
      exit 1
    fi
  done

  sleep 1

  echo "[anchor-test] running mocha suite for $test_label"
  mocha_args=(
    -p ./tsconfig.json
    -t "$MOCHA_TIMEOUT_MS"
    --fail-zero
    --exit
  )
  if [[ "$MOCHA_BAIL" == "1" ]]; then
    mocha_args+=(--bail)
  fi
  if [[ -n "$test_grep" ]]; then
    mocha_args+=(--grep "$test_grep")
  fi
  mocha_args+=("$test_target")

  if ! ANCHOR_PROVIDER_URL="$current_rpc_url" \
    ANCHOR_WS_URL="$current_ws_url" \
    ANCHOR_WALLET="$WALLET_PATH" \
    HYPERIA_MAX_ORACLE_STALENESS_SECONDS="$MAX_ORACLE_STALENESS_SECONDS" \
      "${TS_MOCHA_COMMAND[@]}" "${mocha_args[@]}" 2>&1 | tee -a "$TEST_LOG"; then
    printf '[anchor-test] failed: %s\n' "$test_label" >&2
    tail -n 120 "$VALIDATOR_LOG" >&2 || true
    exit 1
  fi

  stop_validator
  test_index=$((test_index + 1))
done
