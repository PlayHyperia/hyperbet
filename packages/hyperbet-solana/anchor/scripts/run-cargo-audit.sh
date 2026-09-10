#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

AUDIT_JSON="$(mktemp)"
METADATA_JSON="$(mktemp)"
trap 'rm -f "$AUDIT_JSON" "$METADATA_JSON"' EXIT

set +e
cargo audit --json "$@" > "$AUDIT_JSON"
AUDIT_STATUS=$?
set -e

cargo metadata --locked --format-version 1 > "$METADATA_JSON"
node scripts/check-cargo-audit.mjs "$AUDIT_JSON" "$METADATA_JSON" "$AUDIT_STATUS"
