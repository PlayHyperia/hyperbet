# Claim And Refund Availability Recovery

User claims and refunds are wallet-signed Solana transactions. The keeper must
restore canonical lifecycle visibility and terminal custody, but it must never
"drain" claims with a service wallet or maintain a retired off-chain claim
backlog.

## Symptoms

- a resolved winner cannot see or submit a valid claim;
- a cancelled duel does not expose the expected refund;
- loser cleanup, filled-order cleanup, or empty-balance rent recovery is absent;
- lifecycle API, on-chain market state, and the browser disagree after restart.

## Read-only detection

```bash
curl -sS "$KEEPER_URL/health" | jq
curl -sS "$KEEPER_URL/ready" | jq
curl -sS "$KEEPER_URL/status" | jq
curl -sS "$KEEPER_URL/api/keeper/bot-health" | jq
curl -sS "$KEEPER_URL/api/arena/prediction-markets/active" | jq
bun run --cwd packages/hyperbet-solana/keeper terminal-ops feed-status --db "$KEEPER_DB_PATH"
bun run --cwd packages/hyperbet-solana/keeper terminal-ops list --db "$KEEPER_DB_PATH" --status PENDING PROCESSING MANUAL_REVIEW DEAD_LETTER
```

For each report, record the wallet public key, duel key, canonical market PDA,
expected action, transaction signature if one exists, and the public error. Do
not request seed phrases, private keys, wallet exports, or a blind second
signature.

## Immediate containment

1. If canonical terminal state is uncertain, stop the duel bot and keep new
   order placement failed closed.
2. Preserve the feed checkpoint, exact terminal event/fingerprint, market/duel
   accounts, vault and fee counters, user balance and order accounts, signature
   status, bot health, terminal ledger, and service logs.
3. Do not claim for the user, edit SQLite, manufacture a terminal event, bypass
   the dispute window, or reinterpret a null/unknown winner.
4. A known or possibly submitted signature must be checked before the user is
   asked to review a new transaction.

## Recovery

1. Prove the authoritative outcome and canonical duel key from the retained
   schema-v3 feed checkpoint and on-chain oracle account.
2. Prove the market is exactly `RESOLVED` or `CANCELLED`, references that duel,
   and has the expected winner/cancellation state. `PROPOSED` and `CHALLENGED`
   markets remain non-claimable.
3. Inspect related terminal work. Requeue only eligible quarantined/dead-letter
   work after independent evidence review with the exact fingerprint, operator
   identity, and reason. Never requeue a successful operation.
4. Require keeper startup reconciliation to settle its own balance, release
   resolved execution-fee escrow exactly once, and refresh settled health before
   removing the market from recovery. Cancellation keeps execution fees in user
   refunds and must not run resolved fee release.
5. Refresh the public lifecycle/history surface. The browser must independently
   re-derive and refetch the canonical market, duel, user balance/order, vault,
   recipient, and action immediately before a user signature.
6. Have the user review one fresh action only when the prior signature is proven
   absent/failed or its blockhash is expired. Never auto-resubmit.
7. Reconcile the confirmed result: exact user credit, fee/refund/payout fields,
   account rent return, closed eligible PDA, vault liabilities, and immutable
   transaction receipt.

## Success criteria

- the correct winner sees one claim, cancellation participants see refunds,
  losers see cleanup only, and empty terminal balances expose rent recovery only;
- duplicate claim/refund/cleanup attempts reject without moving value;
- resolved execution-fee escrow releases once; cancelled escrow returns to the
  contributing users;
- no claim is executed by an operator or keeper on behalf of a user;
- public history and on-chain state agree and no recovery/terminal queue residue
  remains.

## Escalate and keep affected actions disabled when

- authoritative feed and finalized chain state disagree;
- a challenged/proposed result is presented as claimable;
- an ambiguous signature cannot be resolved;
- vault liabilities, fee counters, payout, refund, or rent do not reconcile;
- recovery would require a privileged claim, database edit, or synthetic result.

Retain the redacted before/after state, user-visible copy, signatures/statuses,
terminal-operation audit history, balance reconciliation, release SHA, operator
decision, and UTC timeline.
