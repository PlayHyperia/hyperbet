# Canonical Solana Duel-Market Specification

## Scope

The launch protocol consists of `fight_oracle` and `duel_market`. All value is represented as integer lamports of native SOL.

## Duel identity and timing

- `duel_key` is the canonical 32-byte identity shared by stream, oracle, market, keeper, API, and UI.
- participant hashes are non-zero and distinct.
- every duel stores a positive competitive-snapshot schema version and non-zero 32-byte digest; this commitment identifies the exact pre-duel agent state presented to bettors.
- open time is positive, close time is after open time, and duel start is not before close.
- participant identity, competitive-snapshot commitment, and all published phase boundaries become immutable once betting opens.
- chain time, never browser or keeper wall-clock time, enforces lifecycle boundaries.

## Oracle lifecycle

Valid statuses are `Scheduled`, `BettingOpen`, `Locked`, `Proposed`, `Challenged`, `Resolved`, and `Cancelled`.

- only forward lifecycle transitions are valid
- a result can be proposed only from `Locked`, after the betting close, with a valid A/B winner and bounded result time
- each proposal binds duel key, result hash, replay hash, winner, seed, and duel-end timestamp to a unique proposal record
- the program recomputes and verifies `result_hash`; a reporter cannot submit an arbitrary digest
- the configured challenger can challenge only before the dispute deadline
- a challenged result must be replaced by a new proposal
- the configured finalizer can finalize an unchallenged proposal only after the dispute window
- resolved and cancelled states are terminal

### Canonical result hash v2

`result_hash` is SHA-256 over the following fixed-width byte sequence, without JSON, delimiters, or length prefixes:

1. ASCII domain `hyperia-duel-result-v2`
2. 32-byte `duel_key`
3. one winner byte (`1` for side A, `2` for side B)
4. `seed` as unsigned 64-bit little-endian
5. 32-byte replay SHA-256
6. competitive-snapshot version as unsigned 32-bit little-endian
7. 32-byte competitive-snapshot digest

The keeper and program share a fixed cross-runtime test vector. Any missing, malformed, zero, changed, or mismatched competitive-snapshot commitment fails closed before a proposal can be recorded.

## Account schema and upgrade policy

`OracleConfig` and `DuelState` carry account schema version `2`. Every new field is appended after the complete v1 serialization prefix; Rust tests bind the exact v1 prefix and the 149-byte oracle-config and 575-byte duel-state allocations. Every lifecycle instruction requires the v2 marker.

An initialized v1 fight-oracle program identity must not be upgraded in place. Legacy duels never committed the snapshot required by result-hash v2, so retroactively populating that state would create unauditable terminal truth. The read-only deployment preflight inspects the canonical oracle-config PDA before any deployment mutation:

- an absent config is accepted because that program identity has never been initialized and cannot contain valid duel state;
- an exact initialized v2 config is accepted for a same-schema upgrade;
- a v1-sized config, wrong owner, executable account, wrong discriminator, unknown length, or unknown version is rejected;
- a rejected initialized identity must remain on its old code while operators complete its refund/retirement plan, and launch must select a fresh v2 program identity.

Initialization, configuration convergence, deployment verification, keeper readiness, manual resolution, and dispute evidence all require schema v2. Dispute packages emitted after this boundary use evidence schema v2; the verifier retains immutable schema-v1 packages without relabeling them as current-schema evidence.

## Market lifecycle

A duel-winner market can be created only for a canonical `BettingOpen` or `Locked` duel by the configured authority/operator. It snapshots treasury, liquidity recipient, and all fee rates. Sync maps oracle state to `Open`, `Locked`, `Resolved`, or `Cancelled`; sync and user cleanup remain available during an emergency trading pause.

## Orders

- side is bid or ask
- price is an integer tick strictly between 0 and 1000
- amount is positive and divisible by 1000
- the order ID must equal the market's next canonical order ID
- matching is price-time priority with explicit linked price levels and bounded remaining accounts
- self-trade policy, post-only, immediate-or-cancel, and good-until-cancelled behavior are explicit
- only the maker can cancel an active open-market order
- unmatched locked value is refunded on cancellation/reclaim
- terminal resting orders are reclaimed through the dedicated terminal-safe instruction

For price `P` and share amount `A`:

- bid lock: `A × P / 1000`
- ask lock: `A × (1000 - P) / 1000`

All arithmetic must be exact, checked, and non-zero.

## Fees and custody

Trade fees apply only to executed taker cost. They accrue inside the market vault and in the user's fee ledger; they do not leave custody while cancellation remains possible.

- on cancellation, the user's locked collateral and accrued execution fees are refunded and market fee accrual is reduced by the exact same amount
- on resolution, winning shares pay the snapshotted winnings fee and the net payout goes to the user
- only after resolution may anyone trigger execution-fee withdrawal, and recipients are the immutable snapshotted treasury/liquidity accounts
- fee basis points are bounded and configuration is explicit/frozen for launch

## Terminal cleanup

- winner claim clears the complete user balance and closes the account
- cancelled-market claim refunds all locked collateral plus escrowed execution fees, then closes the account
- a resolved loser can close only a balance with no winning entitlement; the instruction transfers no market funds and returns account rent only
- order, price-level, balance, and settlement cleanup is idempotent and must not create value

## Off-chain acceptance

The keeper and API must rebuild truth from finalized on-chain instructions/events and canonical accounts. Any identity mismatch, incomplete history, unsupported invocation, fee inconsistency, source discontinuity, contradictory terminal input, or recovery drift fails readiness closed.
