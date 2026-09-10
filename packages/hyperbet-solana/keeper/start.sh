#!/usr/bin/env bash
set -euo pipefail

case "${NODE_ENV:-}" in
  production|staging)
    if [[ -z "${HYPERBET_RUNTIME_ROLE:-}" ]]; then
      echo "[start] HYPERBET_RUNTIME_ROLE is required in production and staging" >&2
      exit 64
    fi
    ;;
esac

export HYPERBET_RUNTIME_ROLE="${HYPERBET_RUNTIME_ROLE:-service}"

case "${HYPERBET_RUNTIME_ROLE}" in
  service)
    echo "[start] launching read-only SOL keeper API"
    exec bun --bun src/service.ts
    ;;
  duel-bot)
    echo "[start] launching dedicated SOL duel lifecycle bot"
    exec bun --bun src/duelBot.ts --no-once
    ;;
  *)
    echo "[start] HYPERBET_RUNTIME_ROLE must be service or duel-bot" >&2
    exit 64
    ;;
esac
