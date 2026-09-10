# Solana RPC Outage Or Degradation

The launch has one supported chain: the configured Solana cluster. There is no
alternate-chain fallback. An RPC failover must preserve the exact cluster
genesis identity and canonical program/config state.

## Symptoms

- RPC proxy failures, timeouts, throttling, or stale block height;
- bot health reports RPC degradation, transaction ambiguity, or stalled market
  reconciliation;
- the service is reachable but `/ready` fails or lifecycle indexing stops.

## Read-only detection

```bash
curl -sS "$KEEPER_URL/health" | jq
curl -sS "$KEEPER_URL/ready" | jq
curl -sS "$KEEPER_URL/status" | jq '.cluster, .programs, .proxies, .readiness'
curl -sS "$KEEPER_URL/api/keeper/bot-health" | jq
bun run --cwd packages/hyperbet-solana/keeper terminal-ops feed-status --db "$KEEPER_DB_PATH"
bun run --cwd packages/hyperbet-solana/keeper terminal-ops list --db "$KEEPER_DB_PATH" --status PENDING PROCESSING MANUAL_REVIEW DEAD_LETTER
```

Run the matching read-only deployment verifier from the quote-disablement
runbook. Record only its redacted evidence output; never print or archive the RPC
credential itself.

## Immediate containment

1. Stop the dedicated duel bot so it cannot create markets, quote, settle, or
   retry an ambiguous transaction against an unreliable provider.
2. Keep read-only service/UI paths available only while they truthfully remain
   stale/failed-closed. Confirm no order control is enabled.
3. Preserve signatures, last-valid block heights, transaction stages, source
   epoch/sequence, bot health, terminal operations, and logs before restart.
4. Do not resubmit a transaction with a known or possible signature. It must be
   resolved through bounded confirmed/finalized status inspection first.

## Recovery

1. Determine whether the fault is provider-specific or cluster-wide using an
   independently monitored endpoint with the same expected genesis hash.
2. Approve any provider change through secret/config management. The replacement
   must pass TLS policy, exact genesis/program/config verification, finality
   behavior, rate limits, and redaction checks before use.
3. Update the service and bot RPC configuration together. Never point browser,
   service, and bot at different cluster identities.
4. Start the read-only service first and require program/config and proxy health
   to converge.
5. Start the duel bot once. Its ambiguous-transaction recovery, feed replay,
   market discovery, owned-order recovery, and terminal custody reconciliation
   must finish without duplicate side effects.
6. Confirm canonical active-market state and all health endpoints, then run one
   bounded staged action before restoring normal limits.

## Success criteria

- replacement RPC reports the approved genesis hash and executable programs;
- current config, roles, recipients, fees, and pause state match the launch
  specification;
- no unresolved transaction, terminal operation, market drift, or recovery
  reason remains;
- lifecycle/feed, on-chain market, public API, and browser authority agree;
- exact wallet, vault, collateral, fee, refund, and rent accounting reconciles.

## Escalate and keep writes disabled when

- more than one approved provider disagrees on finalized state;
- a possible submitted signature remains unknown;
- program/config identity differs after failover;
- owned orders or terminal custody cannot be reconstructed;
- recovery requires bypassing finality, quarantine, or role separation.

Retain redacted provider errors, verification evidence, all affected signatures,
health snapshots, logs, the approved provider-change record, and the exact UTC
timeline.
