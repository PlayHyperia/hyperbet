# Cold-Authority Pause And Duel Cancellation

This procedure covers the frozen-config emergency controls in the SOL duel-only
programs. It does not grant authority to sign or broadcast. The config authority
or reporter, multisig policy, approvers, RPC, fee payer, reason, impacted duel,
and incident commander must be independently approved before any on-chain
action.

The repository tool creates one unsigned instruction plan at a time. It never
loads a private key, creates a transaction, chooses a blockhash, signs, sends,
or treats its output as broadcast authorization.

## Critical ordering rule

Market pause and oracle pause have different fund-safety effects:

- `set_market_paused(true, true)` blocks new order placement and new market
  creation while leaving order cancellation, terminal market synchronization,
  claims, refunds, rent cleanup, and resolved-fee release available.
- `set_oracle_paused(true)` blocks oracle upsert, duel cancellation, result
  proposal/challenge/reproposal, and finalization. It must not be applied before
  an active duel is safely cancelled or resolved unless the approved incident
  decision is explicitly to freeze every oracle transition.
- `cancel_duel` itself requires the oracle to be unpaused and accepts only a
  scheduled, betting-open, or locked duel. It is authorized by the exact config
  authority or configured reporter.

Contain new exposure with the market pause first. Cancel or finish the exact
active duel second. Pause the oracle last only when the approved incident policy
requires it. Recovery reverses this dependency: restore oracle transitions
while the market remains paused, reconcile, then restore market creation/order
placement last.

## Stop conditions

Do not continue when:

- the current cluster/genesis, program IDs, ProgramData, upgrade authority,
  frozen configs, config authority, reporter, roles, recipients, or fees differ
  from the approved release record;
- the active duel key/state, market, source checkpoint, or terminal custody is
  ambiguous;
- the required signer is a hot keeper/service key when cold approval is
  required, or a signer is not exactly authorized by the on-chain config;
- the instruction plan, simulation, multisig proposal, or decoded transaction
  differs by one byte, account meta, program, PDA, boolean, duel key, or metadata
  URI;
- the transaction has an ambiguous status, the approved RPC cannot provide
  finalized readback, or independent review is unavailable;
- user claim/refund/cancel paths would be disabled or the operation would
  require a database edit, synthetic lifecycle event, forced outcome, or blind
  resubmission.

Remain contained and escalate. A runbook is not permission to bypass a stop
condition.

## Read-only preflight

Stop the dedicated duel bot through the approved platform procedure and capture
keeper health, feed checkpoint, active duel/market, owned orders, terminal
operations, and custody evidence. Keep public transaction authority disabled.

Run the cluster-specific verifier with the exact current pause expectation. For
an ordinary unpaused start:

```bash
bun run --cwd packages/hyperbet-solana verify:deployment:mainnet -- \
  --expect-oracle-paused=false \
  --expect-order-placement-paused=false \
  --expect-market-creation-paused=false \
  --out="$PRE_ACTION_DEPLOYMENT_EVIDENCE_PATH"
```

Use `verify:deployment:devnet` for the transaction-disabled rehearsal. Never
switch cluster to make a failed identity check pass. Supply expected authority,
upgrade authority, roles, recipients, fees, and RPC only through the approved
environment mechanism.

## Build one unsigned instruction plan

Choose a new mode-0600 output pathname. To contain new exposure:

```bash
bun run --cwd packages/hyperbet-solana emergency:plan -- \
  --action=market-pause \
  --cluster="$SOLANA_CLUSTER" \
  --release-sha="$RELEASE_SHA" \
  --expected-signer="$CONFIG_AUTHORITY_PUBLIC_KEY" \
  --output="$EMERGENCY_PLAN_PATH"
```

Supported single-action plans are `market-pause`, `market-unpause`,
`oracle-pause`, `oracle-unpause`, and `cancel-duel`. A cancellation additionally
requires the exact immutable duel key and an approved bounded metadata URI:

```bash
bun run --cwd packages/hyperbet-solana emergency:plan -- \
  --action=cancel-duel \
  --cluster="$SOLANA_CLUSTER" \
  --release-sha="$RELEASE_SHA" \
  --expected-signer="$APPROVED_CANCELLATION_SIGNER_PUBLIC_KEY" \
  --duel-key="$DUEL_KEY_HEX" \
  --metadata-uri="$CANCELLATION_METADATA_URI" \
  --output="$CANCELLATION_PLAN_PATH"
```

The output binds the release, cluster, registry program, canonical config/duel
PDA, exact signer meta, exact Anchor discriminator/arguments, instruction bytes
and SHA-256, and expected post-state. It records
`broadcastAuthorized: false`, requires simulation/readback, rejects a zero
signer, noncanonical duel key, unsupported metadata scheme, metadata over 200
bytes, irrelevant arguments, or an existing output path.

## Independent review, simulation, and approval

1. A reviewer who did not build the plan reads the finalized on-chain config
   and independently derives the program ID, PDA, authorized signer, instruction
   discriminator, arguments, and account mutability. Compare every value and
   the instruction-data hash with the plan and checked-in synchronized IDL.
2. Reconfirm current duel and market state immediately before proposal. For
   cancellation, prove the duel is scheduled, betting-open, or locked and not
   already terminal; bind the approved reason/evidence to the exact metadata
   URI without private or mutable content.
3. Recreate exactly one instruction in the approved cold multisig/hardware
   workflow. Do not upload or import private material into this repository,
   shell, CI, browser build, or service.
4. Simulate the complete proposed transaction against the exact cluster and
   current finalized accounts. Decode the simulation independently and prove no
   unexpected account, instruction, balance, program, or state change. A
   successful simulation is not approval to broadcast.
5. Obtain the required human approvals under the recorded quorum/change policy.
   The approvers verify the plan hash, decoded transaction, recent blockhash/fee
   payer, incident scope, recovery path, and user-fund effects.

## Submit and prove state

Submission occurs only in the approved custody system. Record the proposal ID,
approvers, decoded transaction, signature, slot, fee payer/fee, and exact UTC
times without exposing private material. Never blind-resubmit an ambiguous
signature; classify it from canonical chain status first.

After a market pause, verify with:

```bash
bun run --cwd packages/hyperbet-solana verify:deployment:mainnet -- \
  --expect-oracle-paused=false \
  --expect-order-placement-paused=true \
  --expect-market-creation-paused=true \
  --out="$POST_MARKET_PAUSE_EVIDENCE_PATH"
```

Also prove the public app disables new orders while user order cancellation,
terminal sync, claims, refunds, and cleanup remain available. If cancelling a
duel, submit and finalize that separate reviewed instruction while the oracle is
unpaused, then require exact oracle duel-state cancellation and market sync with
full refund/custody reconciliation. Only after every active duel is terminal may
an approved oracle-pause plan be considered.

For both pauses, the expected readback is:

```bash
bun run --cwd packages/hyperbet-solana verify:deployment:mainnet -- \
  --expect-oracle-paused=true \
  --expect-order-placement-paused=true \
  --expect-market-creation-paused=true \
  --out="$POST_FULL_PAUSE_EVIDENCE_PATH"
```

## Staged rehearsal and recovery

The complete sequence must first pass on transaction-disabled devnet with
isolated staging authorities and no real value:

1. readback unpaused state;
2. build/review/simulate/approve/submit market pause;
3. prove order and market creation fail while user recovery remains available;
4. create a disposable staged duel/market, pause the market, cancel the exact
   duel while oracle remains unpaused, sync, and reconcile every refund/fee/rent
   liability;
5. pause the oracle only after no nonterminal staged duel remains and prove
   oracle writes fail;
6. build a separate oracle-unpause plan, review/simulate/approve/submit it, then
   reconcile feed, terminal custody, and one no-value lifecycle while the market
   stays paused;
7. build a separate market-unpause plan and restore order placement/creation
   only after all readiness, identity, and approval gates pass;
8. prove no duplicate duel, market, order, terminal event, fee release, refund,
   or claim, and retain measured containment/recovery timing plus cleanup.

## Launch evidence

Retain before/after deployment-verifier artifacts and hashes, unsigned plan
files/hashes, independently decoded simulations, multisig proposal/approval
records, finalized signatures/slots, exact duel/market/config snapshots, custody
reconciliation, public fail-closed proof, timings, operators, incident decisions,
and cleanup audit. Repository tests and local-validator pause/refund coverage do
not replace the witnessed staging cold-custody rehearsal.
