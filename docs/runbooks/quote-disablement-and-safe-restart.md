# SOL Quote Disablement And Safe Restart

This procedure applies only to the dedicated Solana duel bot. The retired
multi-chain market-maker service and its database are not part of the launch
topology.

## Trigger conditions

- quotes are stale, crossed, outside the approved price/exposure policy, or
  inconsistent with the canonical duel phase;
- `/ready` or bot health reports RPC, configuration, funding, discovery,
  recovery, or market drift;
- the duel bot is restarting repeatedly or cannot reconcile its owned orders.

## Read-only detection

Capture these responses before stopping anything. Do not include an RPC URL,
cookie, bearer token, or private environment value in the incident bundle.

```bash
curl -sS "$KEEPER_URL/health" | jq
curl -sS "$KEEPER_URL/ready" | jq
curl -sS "$KEEPER_URL/status" | jq
curl -sS "$KEEPER_URL/api/keeper/bot-health" | jq
curl -sS "$KEEPER_URL/api/arena/prediction-markets/active" | jq
bun run --cwd packages/hyperbet-solana/keeper terminal-ops feed-status --db "$KEEPER_DB_PATH"
bun run --cwd packages/hyperbet-solana/keeper terminal-ops list --db "$KEEPER_DB_PATH" --status PENDING PROCESSING MANUAL_REVIEW DEAD_LETTER
```

Record the release SHA, Solana cluster/genesis identity, both program IDs,
market and duel keys, last healthy timestamp, source epoch/sequence, and every
owned order ID.

## Immediate containment

1. Stop only the dedicated duel-bot service through the approved deployment
   platform. Keep the read-only HTTP service available if it remains accurate.
2. Confirm `/ready` is failed and the public application no longer enables new
   orders. Do not preserve quoting merely to preserve uptime.
3. Do not edit SQLite, delete an order account, synthesize a lifecycle event,
   force a result, reuse a broad admin key, or run a retired service.
4. Preserve bot/service logs and an approved consistent snapshot of the keeper
   database and volume before any restart or configuration change.
5. If an on-chain order-placement pause is required, use only the rehearsed,
   separately approved cold-authority procedure after simulation and
   independent review. If that procedure or signer is unavailable, keep the bot
   stopped and escalate; a runbook is not authority to improvise a transaction.

## Recovery

1. Classify the fault: authoritative feed, Solana RPC, program/config identity,
   signer/funding, risk policy, owned-order graph, terminal custody, or service
   release.
2. Run the read-only verifier for the configured cluster. Choose exactly one:

   ```bash
   bun run --cwd packages/hyperbet-solana verify:deployment:devnet
   bun run --cwd packages/hyperbet-solana verify:deployment:testnet
   bun run --cwd packages/hyperbet-solana verify:deployment:mainnet
   ```

   Never substitute a different cluster to make verification pass.

3. Inspect every nonterminal terminal operation with `terminal-ops inspect`.
   Requeue only `MANUAL_REVIEW` or `DEAD_LETTER` work whose canonical chain and
   feed evidence has been independently verified, using the exact fingerprint,
   operator identity, and reason required by `terminal-ops requeue`.
4. Correct the approved configuration or upstream dependency. Do not mutate
   persisted facts to match the desired answer.
5. Start the dedicated duel bot once. Require startup discovery to reconcile
   every configured market and owned order without creating a duplicate market,
   order, terminal operation, or fee release.
6. Wait for current bot health, feed continuity, program/config verification,
   zero active recovery reasons, and canonical active-market agreement. A green
   process alone is insufficient.
7. Re-enable public transaction availability only after a bounded valueless or
   tightly controlled staged action and exact balance/order reconciliation.

## Success criteria

- the one configured Solana cluster, programs, config, feed checkpoint, duel,
  market, and stream identity agree;
- every owned order is canonical, safely cancelled/reclaimed, or explicitly
  quarantined;
- terminal custody and execution-fee escrow reconcile exactly;
- `/health`, `/ready`, `/status`, and bot health are current and coherent;
- no duplicate market, order, terminal event, fee release, refund, or claim was
  created;
- quote resume has an approval identity, UTC timestamp, release SHA, and retained
  before/after evidence.

## Escalate and remain stopped when

- program/config identity, genesis hash, role separation, or fees do not match;
- chain truth cannot be reconciled with the feed checkpoint or keeper ledger;
- an ambiguous signature cannot be proven confirmed or failed;
- the bot recreates work, hot-loops, or requires a database edit;
- recovery would require an unrehearsed signer, pause, cancellation, or release
  operation.
