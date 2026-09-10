#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLANA_ACTIVE_RELEASE_BIN="${SOLANA_ACTIVE_RELEASE_BIN:-$HOME/.local/share/solana/install/active_release/bin}"
if [[ -d "$SOLANA_ACTIVE_RELEASE_BIN" ]]; then
  export PATH="$SOLANA_ACTIVE_RELEASE_BIN:$PATH"
fi
NODE_COMMAND="${ANCHOR_TEST_NODE_BIN:-}"
if [[ -z "$NODE_COMMAND" && -x /opt/homebrew/opt/node@22/bin/node ]]; then
  NODE_COMMAND=/opt/homebrew/opt/node@22/bin/node
fi
if [[ -z "$NODE_COMMAND" ]]; then
  NODE_COMMAND="$(command -v node || true)"
fi
if [[ -z "$NODE_COMMAND" ]]; then
  echo "Missing required command: node" >&2
  exit 1
fi

if ! command -v solana-test-validator >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "[fork-rollback-test] solana-test-validator unavailable in CI; skipping"
    exit 0
  fi
  echo "Missing required command: solana-test-validator" >&2
  exit 1
fi

resolve_wallet_path() {
  local candidates=(
    "${ANCHOR_WALLET:-}"
    "$HOME/.config/solana/hyperia-keys/deployer.json"
    "$HOME/.config/solana/id.json"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "No Anchor wallet found for fork rollback test" >&2
  exit 1
}

TS_MOCHA_ENTRY="$ROOT_DIR/node_modules/ts-mocha/bin/ts-mocha"
MOCHA_PACKAGE="$ROOT_DIR/node_modules/mocha/package.json"
if [[ ! -f "$TS_MOCHA_ENTRY" || ! -f "$MOCHA_PACKAGE" ]]; then
  TS_MOCHA_ENTRY="$ROOT_DIR/../../../node_modules/ts-mocha/bin/ts-mocha"
  MOCHA_PACKAGE="$ROOT_DIR/../../../node_modules/mocha/package.json"
fi
if [[ -f "$TS_MOCHA_ENTRY" && -f "$MOCHA_PACKAGE" ]]; then
  TS_MOCHA_COMMAND=("$NODE_COMMAND" "$TS_MOCHA_ENTRY")
elif command -v bunx >/dev/null 2>&1; then
  WORKSPACE_NODE_MODULES="$ROOT_DIR/../../../node_modules"
  if [[ -d "$WORKSPACE_NODE_MODULES" ]]; then
    export NODE_PATH="$WORKSPACE_NODE_MODULES${NODE_PATH:+:$NODE_PATH}"
  fi
  TS_MOCHA_COMMAND=(bunx "ts-mocha@10.0.0")
else
  echo "Missing ts-mocha binary and bunx fallback" >&2
  exit 1
fi

cd "$ROOT_DIR"
ANCHOR_WALLET="$(resolve_wallet_path)" \
  "${TS_MOCHA_COMMAND[@]}" \
  -p ./tsconfig.json \
  -t 180000 \
  --fail-zero \
  --bail \
  --exit \
  tests/signed-bet-fork-rollback.anchor.ts
