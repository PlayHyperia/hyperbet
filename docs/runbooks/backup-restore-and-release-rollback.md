# Backup, Restore, And Release Rollback

This procedure covers the three durable off-chain stores in the SOL duel
launch: Hyperia's PostgreSQL database, Hyperbet's keeper SQLite database, and
Hyperbet's operator-alert incident/outbox state. Solana program accounts are
canonical chain state and cannot be restored from an off-chain backup. A
backup is not qualified until a separate restore is verified against the exact
release and reconciled with finalized chain truth.

This runbook does not authorize a production stop, restore, deployment, program
upgrade, cold-authority signature, or deletion. The launch owner must approve
the exact environment, release, owners, timing, evidence location, and rollback
target before execution.

## Required approved inputs

- current and rollback release SHAs, build/SBF/IDL hashes, deployment manifests,
  Solana cluster/genesis, program IDs, ProgramData, and upgrade authorities;
- backup owner, restore operator, independent verifier, rollback owner, database
  owners, and incident commander;
- recovery-point and recovery-time objectives, maintenance window, and maximum
  acceptable data loss;
- protected backup destinations, encryption/key ownership, retention, deletion,
  replication, access logging, and restore credentials;
- platform-specific stop/start/snapshot/rollback procedures and service IDs;
- documented database and API compatibility between both release directions;
- approved transaction-disabled staging environment and success criteria.
- one non-secret lowercase maintenance boundary ID tied to the approved change
  or incident record; never put a credential, person, wallet, or private detail
  in that ID.

Missing or placeholder values block the rehearsal. Never place a database URL,
password, private key, bearer token, RPC key, signed stream query, or backup
decryption material in a command transcript or evidence bundle.

## Establish one quiescent boundary

1. Record UTC time, current release identities, current Hyperia authority fence,
   canonical source epoch/sequence, active duel/market, keeper readiness,
   terminal-operation summary, and finalized Solana slot.
2. Disable new public transaction authority through the approved release
   control and confirm it from an independent browser/config observation.
3. Stop only the dedicated Solana duel bot. Preserve accurate read-only HTTP
   access and user wallet-signed claim/refund paths where safe.
4. Stop the sole Hyperia scheduler authority through the approved platform
   procedure and verify its lease cannot create a new cycle. Do not start a
   replacement authority.
5. Let already-submitted RPC work reach a confirmed/finalized or explicitly
   ambiguous classification. Do not auto-resubmit an ambiguous transaction.
6. Capture the final keeper feed checkpoint and terminal ledger. Any
   `PROCESSING`, `MANUAL_REVIEW`, `DEAD_LETTER`, active recovery, unresolved
   custody, or identity drift must be classified and retained; do not edit a
   database to make the boundary appear clean.
7. Stop the sole Hyperbet API service and verify the platform does not start a
   replacement. This freezes both SQLite readers and the alert outbox. Record
   whether the alert state holds an accepted incident or pending delivery; do
   not clear either to make the boundary appear healthy. Public transaction
   authority must already be disabled, and this maintenance impact must be
   approved before stopping the read service.

If a coherent boundary cannot be established, preserve forensic snapshots,
remain stopped for new betting, and escalate.

## Hyperbet keeper SQLite backup

Choose new paths on an approved encrypted destination. The backup and evidence
files must not already exist. From the exact release checkout:

```bash
bun run --cwd packages/hyperbet-solana/keeper keeper-backup create \
  --source="$KEEPER_DB_PATH" \
  --backup="$KEEPER_BACKUP_PATH" \
  --evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER"
```

The command verifies every launch accounting/feed/terminal table, full SQLite
integrity, foreign keys, terminal status vocabulary, schema hash, and all table
counts before creating a consistent `VACUUM INTO` snapshot. It rejects an
observed concurrent source commit, compares the resulting snapshot with the
quiescent source, creates mode-0600 files, records no source directory, hashes
the backup by streaming it, and refuses to overwrite either destination.

Independently verify the retained pair before moving it:

```bash
bun run --cwd packages/hyperbet-solana/keeper keeper-backup verify \
  --backup="$KEEPER_BACKUP_PATH" \
  --evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER"
```

A successful command proves the file/evidence pair, not the object store,
retention policy, restore process, service compatibility, or chain agreement.

## Keeper schema compatibility and deployment binding

Audit the stopped source database before a release or restore:

```bash
bun run --cwd packages/hyperbet-solana/keeper keeper-db audit \
  --database="$KEEPER_DB_PATH"
```

Schema v2 requires every verified SOL bet to carry one exact cluster and duel
market program binding. An unbound legacy bet, malformed identity, missing
canonical table, or unexpected schema version keeps database health red and
prevents new public bet records. Do not edit or backfill those rows manually.

If the audit requires the reviewed legacy migration, first retain and
independently verify the exact quiescent backup above. The launch owner must
also attest that every previously verified bet in this database belongs to one
and only one approved deployment. A database known or suspected to contain
multiple deployments must be escalated instead of attributed wholesale. Run
the backup-bound migrator with the approved identities:

```bash
bun run --cwd packages/hyperbet-solana/keeper keeper-db apply \
  --database="$KEEPER_DB_PATH" \
  --backup="$KEEPER_BACKUP_PATH" \
  --evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --program-id="$DUEL_MARKET_PROGRAM_ID"
```

The migrator refuses a changed source, invalid program identity, conflicting
existing deployment binding, reused backup, or nonconvergent audit. Afterward,
repeat the read-only audit and retain both outputs with the approved change
record. This command authorizes only the reviewed SQLite migration; it does not
authorize a service start, program deployment, wallet signature, or cutover.

## Hyperbet operator-alert state backup

The API service must remain stopped while this recovery set is created. Use new
paths on the same approved encrypted destination as the keeper database backup:

```bash
bun run --cwd packages/hyperbet-solana/keeper operator-alert-state-backup create \
  --source="$HYPERBET_OPERATOR_ALERT_STATE_FILE" \
  --backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID"
```

The command requires an existing valid mode-0600 state file bound to the exact
route, writes a canonical mode-0600 backup without overwrite, rechecks that the
source did not change, and creates independently fsynced evidence. Evidence
contains only release, cluster, route ID, filenames, hash/size, and bounded
pending/delivered status. It does not retain the webhook URL, bearer token,
provider response, exception, wallet, signer, bank state, or private strategy.

Verify the alert-state pair independently alongside the SQLite pair:

```bash
bun run --cwd packages/hyperbet-solana/keeper operator-alert-state-backup verify \
  --backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID"
```

Retain the SQLite backup/evidence and alert-state backup/evidence as one named
recovery set with the same quiescent-boundary record. Bind all four files before
moving them:

```bash
bun run --cwd packages/hyperbet-solana/keeper keeper-recovery-set create \
  --keeper-backup="$KEEPER_BACKUP_PATH" \
  --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
  --boundary-id="$RECOVERY_BOUNDARY_ID"
```

The private manifest re-verifies both component pairs, hashes every backup and
evidence file by streaming it through a no-symlink descriptor, and binds their
safe filenames, sizes, hashes, release, cluster, route, and operator-supplied
boundary ID. It records the exact component evidence timestamp skew but does
not invent or approve an acceptable skew. It explicitly identifies its scope
as `file_pair_binding_only` and keeps
`quiescentBoundaryWitnessRequired=true`; a green command cannot prove that the
services were stopped or that the boundary met the approved RPO.

Independently verify the complete set before moving or restoring it:

```bash
bun run --cwd packages/hyperbet-solana/keeper keeper-recovery-set verify \
  --keeper-backup="$KEEPER_BACKUP_PATH" \
  --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
  --release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
  --boundary-id="$RECOVERY_BOUNDARY_ID"
```

Do not combine a pair or manifest from another release, cluster, route,
boundary ID, or maintenance window. Any changed byte invalidates the set.

## Hyperia PostgreSQL backup

Use Hyperia's canonical full-snapshot tool from the exact approved Hyperia
release. Supply one exact mode-0600 `PGPASSFILE` entry and the approved TLS
variables; the command rejects `PGPASSWORD`, `DATABASE_URL`, `POSTGRES_URL`,
`PGSERVICE`, and `PGOPTIONS` rather than putting a password-bearing URL on the
command line. The new destination container must not already exist.

```bash
bun run --cwd "$HYPERIA_REPOSITORY/packages/server" db:backup-recovery create \
  --database="$HYPERIA_DATABASE" \
  --release-sha="$HYPERIA_RELEASE_SHA" \
  --boundary-id="$RECOVERY_BOUNDARY_ID" \
  --destination-container="$HYPERIA_BACKUP_CONTAINER_PATH" \
  --query-timeout-ms=60000 \
  --dump-timeout-ms=3600000

bun run --cwd "$HYPERIA_REPOSITORY/packages/server" db:backup-recovery verify \
  --database="$HYPERIA_DATABASE" \
  --release-sha="$HYPERIA_RELEASE_SHA" \
  --boundary-id="$RECOVERY_BOUNDARY_ID" \
  --backup-root="$HYPERIA_BACKUP_CONTAINER_PATH/active" \
  --tool-timeout-ms=60000
```

The command binds the custom archive and canonical `pg_restore --list` TOC to
the Hyperia release, same boundary ID, database/server/encoding, every checked-
in migration byte, public schema fingerprint/object counts, and every row count
in the exact public table inventory. It publishes only one private `active/`
pair through an atomic rename and refuses overwrite. Follow the complete
Hyperia runbook at `docs/hyperia-postgres-backup-recovery.md` in that release.

## Cross-repository recovery-set binding

After the Hyperia pair and Hyperbet four-file keeper set independently verify,
bind them to one platform manifest. Use both repositories' distinct full
release SHAs and the same approved boundary ID:

```bash
bun run --cwd packages/hyperbet-solana/keeper platform-recovery-set create \
  --keeper-backup="$KEEPER_BACKUP_PATH" \
  --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --keeper-recovery-set-manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-backup="$HYPERIA_BACKUP_CONTAINER_PATH/active/hyperia-postgres.dump" \
  --hyperia-evidence="$HYPERIA_BACKUP_CONTAINER_PATH/active/evidence.json" \
  --hyperia-migrations-directory="$HYPERIA_REPOSITORY/packages/server/src/database/migrations" \
  --platform-manifest="$PLATFORM_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-release-sha="$HYPERIA_RELEASE_SHA" \
  --hyperia-database="$HYPERIA_DATABASE" \
  --hyperbet-release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
  --boundary-id="$RECOVERY_BOUNDARY_ID" \
  --tool-timeout-ms=60000 \
  --pg-restore-executable=pg_restore
```

The command re-verifies all five underlying Hyperbet files, the Hyperia
archive/TOC/evidence/migration bytes, and strict private layouts before writing
one new mode-0600 manifest without source paths. It records the exact component
timestamp skew but does not approve it. Its scope is
`cross_repository_file_binding_only`, requires a witnessed quiescent boundary,
and reports `activationRequiresSeparateApproval=true`.

Independently rerun the same command with `verify` instead of `create` before
moving, restoring, or using any component. Any changed component byte, release,
cluster, route, database, migration, or boundary invalidates the platform set.

## Separate restore rehearsal

Never test a restore over the only production database or volume.

1. Provision empty, isolated, access-restricted restore destinations on the
   approved transaction-disabled staging rail. Record their owner and automatic
   expiry; do not reuse a prior rehearsal database.
2. Re-run both `keeper-recovery-set verify` and `platform-recovery-set verify`
   against all retained components and the exact approved boundary ID.
   Independently review the recorded component timestamp skew against the
   maintenance record; the tools deliberately have no built-in approval
   threshold.
3. Materialize the complete verified Hyperbet pair into a new path whose parent
   already exists. The destination container itself must not exist:

   ```bash
   bun run --cwd packages/hyperbet-solana/keeper keeper-recovery-set materialize \
     --keeper-backup="$KEEPER_BACKUP_PATH" \
     --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
     --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
     --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
     --manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
     --release-sha="$RELEASE_SHA" \
     --cluster="$SOLANA_CLUSTER" \
     --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
     --boundary-id="$RECOVERY_BOUNDARY_ID" \
     --destination-container="$RESTORED_KEEPER_CONTAINER_PATH"
   ```

   The command re-verifies the complete source set, exclusively creates a
   mode-0700 container, copies and validates the exact SQLite and alert-state
   bytes under a private staging subtree, records a mode-0600 materialization
   manifest, then publishes the complete `active/` subtree with one
   same-filesystem rename. A killed process before that rename cannot expose an
   `active/` runtime path. Never reuse or start from a container that has only a
   `.staging-*` subtree; preserve it and remove it only under the approved
   cleanup procedure for a failed rehearsal.

4. Independently verify the published runtime root before any service opens the
   SQLite database and creates WAL/SHM sidecars:

   ```bash
   bun run --cwd packages/hyperbet-solana/keeper keeper-recovery-set verify-materialized \
     --keeper-backup="$KEEPER_BACKUP_PATH" \
     --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
     --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
     --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
     --manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
     --release-sha="$RELEASE_SHA" \
     --cluster="$SOLANA_CLUSTER" \
     --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
     --boundary-id="$RECOVERY_BOUNDARY_ID" \
     --materialized-root="$RESTORED_KEEPER_CONTAINER_PATH/active"
   ```

   This verifies exact source provenance, root contents, owner-only modes,
   hashes, SQLite integrity/schema/logical data/table/terminal counts, and the
   route-bound alert state. Its scope is
   `isolated_restore_materialization_only` and
   `activationRequiresSeparateApproval=true`; success does not authorize a
   service start, production replacement, or deletion. Configure the rehearsal
   only with
   `KEEPER_DB_PATH=$RESTORED_KEEPER_CONTAINER_PATH/active/keeper.sqlite` and
   `HYPERBET_OPERATOR_ALERT_STATE_FILE=$RESTORED_KEEPER_CONTAINER_PATH/active/status/operator-alert-state.json`.

   The standalone `operator-alert-state-backup restore` action remains
   available for an explicitly approved alert-state-only forensic inspection,
   but it is not a substitute for paired materialization and must never be used
   to assemble a launch-eligible recovery root manually.

5. Restore the Hyperia custom dump into the empty recovery database with the
   approved matching `pg_restore`, `--exit-on-error`, `--no-owner`, and
   `--no-privileges` controls. Do not target production. Then run Hyperia's
   `db:backup-recovery verify-restored` command with the exact source and target
   database names, release, boundary, backup root, and explicitly approved
   target `server_version_num`. Its success is isolated-restore evidence only,
   never cutover authority. Run `db:restore-recovery-evidence create` to retain
   that verification as a new private certificate, then have the independent
   verifier run `db:restore-recovery-evidence verify` against the same restored
   database and certificate. The Hyperia runbook contains the exact commands.
6. Run full PostgreSQL constraint/integrity and migration-journal checks. Start
   the exact backed-up Hyperia release without scheduler/capture authority and
   the exact backed-up Hyperbet read service without the duel bot or transaction
   authority. Configure the restored alert state path and exact backed-up route;
   any corrupt-state or route-drift startup refusal is a failed recovery set,
   not permission to delete the file. Any automatic destructive or
   backward-incompatible migration is a failed rehearsal.

   The Hyperia production server boot path is intentionally not a pure read: it
   advances the durable betting-source epoch once and acquires/releases its
   named scheduler lease even when duel scheduling is disabled. Before startup,
   record all 58 table digests. After graceful shutdown, require that only
   `storage` and `streaming_scheduler_leases` changed, that the source epoch
   advanced exactly once, and that the exact boot lease is released/expired.
   Any other change fails the rehearsal. Do not rewind or delete monotonic epoch
   or lease records on a real recovery candidate. The owned-local disposable
   qualifier's exact-row cleanup exists only to re-certify its seeded fixture;
   it is not an operator recovery procedure.

7. Compare the restored Hyperia fence, cycle, immutable competitive snapshot,
   frozen loadout, custody/progression receipts, action ledger, and duel history
   with the backup boundary. Compare every restored keeper table count, schema
   hash, feed checkpoint, competitive snapshot, evidence frame, bet/accounting
   fact, settlement, and terminal status with its evidence. Compare the exact
   restored alert route, pending delivery ID/status, accepted-incident status,
   and last-delivered status with the alert evidence.
8. Against the configured read-only RPC, verify cluster/genesis, executable
   programs, ProgramData/loader/upgrade authority, frozen config/roles/fees,
   every referenced duel/market, and confirmed/finalized signatures. Database
   state must reconcile to chain state; a restore never rewinds Solana.
9. Start one staging scheduler authority and one duel bot only after the
   restored state is coherent. Require monotonic fencing/source sequence, no
   duplicate cycle/market/order/terminal/fee release, exact terminal custody,
   and one smallest-safe no-value lifecycle before measuring recovery time.
10. Preserve hashes, commands with secrets removed, before/after summaries,
    exact timings, observer approvals, and cleanup evidence. Remove the isolated
    restore only through its separately approved expiry/cleanup procedure.

## Bind the completed restore rehearsal

After the independent Hyperia restore-evidence verification and Hyperbet
`verify-materialized` command both pass, bind those exact outputs back to the
same platform recovery set:

```bash
bun run --cwd packages/hyperbet-solana/keeper platform-recovery-rehearsal create \
  --keeper-backup="$KEEPER_BACKUP_PATH" \
  --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --keeper-recovery-set-manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-backup="$HYPERIA_BACKUP_CONTAINER_PATH/active/hyperia-postgres.dump" \
  --hyperia-evidence="$HYPERIA_BACKUP_CONTAINER_PATH/active/evidence.json" \
  --hyperia-migrations-directory="$HYPERIA_REPOSITORY/packages/server/src/database/migrations" \
  --platform-manifest="$PLATFORM_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-restore-evidence="$HYPERIA_RESTORE_EVIDENCE_PATH" \
  --materialized-root="$RESTORED_KEEPER_CONTAINER_PATH/active" \
  --rehearsal-manifest="$PLATFORM_RECOVERY_REHEARSAL_MANIFEST_PATH" \
  --hyperia-release-sha="$HYPERIA_RELEASE_SHA" \
  --hyperia-database="$HYPERIA_DATABASE" \
  --hyperbet-release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
  --boundary-id="$RECOVERY_BOUNDARY_ID" \
  --tool-timeout-ms=60000 \
  --pg-restore-executable=pg_restore
```

Independently rerun the exact command as `platform-recovery-rehearsal verify`
instead of `platform-recovery-rehearsal create`. It
re-verifies every backup and platform component, the complete materialized
keeper root, and the Hyperia certificate's source-file and restored-state
bindings before accepting the rehearsal manifest. The result is strictly
`cross_repository_restore_evidence_binding_only`; it keeps
`quiescentBoundaryWitnessRequired=true`,
`restoredStateReverificationRequiredAtActivation=true`,
`activationRequiresSeparateApproval=true`, and
`productionCutoverAuthorized=false`. It does not prove operator identities,
maintenance-window witness, storage policy, service compatibility, Solana
reconciliation, RPO/RTO, or readiness to cut over.

## Reconcile restored duel state across both databases

Before either restored service starts, create and independently verify the
Hyperia `db:restored-duel-application-readiness` certificate documented in its
PostgreSQL recovery runbook. Point the standard `PG*` variables at the isolated
restored Hyperia database. Use one exact mode-0600 `PGPASSFILE` entry;
`PGPASSWORD`, password-bearing URLs, service files, and `PGOPTIONS` are
rejected. Then bind the live restored PostgreSQL duel truth, exact application
read certificate, and already materialized keeper database:

```bash
bun run --cwd packages/hyperbet-solana/keeper restored-duel-state-reconciliation create \
  --keeper-backup="$KEEPER_BACKUP_PATH" \
  --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --keeper-recovery-set-manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-backup="$HYPERIA_BACKUP_CONTAINER_PATH/active/hyperia-postgres.dump" \
  --hyperia-evidence="$HYPERIA_BACKUP_CONTAINER_PATH/active/evidence.json" \
  --hyperia-migrations-directory="$HYPERIA_REPOSITORY/packages/server/src/database/migrations" \
  --platform-manifest="$PLATFORM_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-restore-evidence="$HYPERIA_RESTORE_EVIDENCE_PATH" \
  --hyperia-application-readiness="$HYPERIA_APPLICATION_READINESS_PATH" \
  --materialized-root="$RESTORED_KEEPER_CONTAINER_PATH/active" \
  --rehearsal-manifest="$PLATFORM_RECOVERY_REHEARSAL_MANIFEST_PATH" \
  --reconciliation-manifest="$RESTORED_DUEL_RECONCILIATION_MANIFEST_PATH" \
  --hyperia-release-sha="$HYPERIA_RELEASE_SHA" \
  --hyperia-database="$HYPERIA_DATABASE" \
  --hyperbet-release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
  --boundary-id="$RECOVERY_BOUNDARY_ID" \
  --tool-timeout-ms=60000 \
  --query-timeout-ms=60000 \
  --pg-restore-executable=pg_restore \
  --psql-executable=psql
```

Independently rerun the exact command as
`restored-duel-state-reconciliation verify`. The command re-verifies the
complete platform rehearsal, reads Hyperia twice under separate
repeatable-read/read-only transactions around the keeper inspection, requires
the two Hyperia semantic digests to remain identical, and re-verifies the
materialized recovery set afterward. It requires a one-to-one match for every
retained competitive snapshot and terminal operation, including duel ID/key,
canonical public snapshot, participants, outcome, winner/side, reason, seed,
replay hash, succeeded terminal status, conflict-free ledger, evidence-frame
custody, and the latest non-degraded feed checkpoint. Empty histories are
allowed for a genuinely pre-launch boundary, but a populated side can never
silently reconcile with an empty one. It also strictly parses and binds the
Hyperia application-readiness certificate, requires its release, boundary,
restore, database, server-version, and source-certificate identity to match the
reconciled state, independently recomputes the digest over its exact sorted
competitive public fact list, and compares each projected cycle/duel,
participants, terminal time, outcome, winner, and public reason to the live
restored PostgreSQL terminal authority. A certificate whose facts and digest
are changed together still fails that live-state comparison. A non-empty
terminal history must expose a non-empty competitive public projection.

The private, no-overwrite result has scope
`cross_repository_restored_duel_state_and_application_read_projection` and records
`productionCutoverAuthorized=false`. It closes database-to-database semantic
reconciliation plus the bounded restored public-history read projection only.
It does not replace the immediately preceding full Hyperia restore-state
verification, actual service startup, finalized Solana account reconciliation,
RPO/RTO measurement, witnessed production-shaped drill, or separate activation
approval. The owned-local harness separately proves both actual service starts:
the production Hyperia server with its exact epoch/lease mutation boundary, and
the production-role Hyperbet read service against a byte-identical copy of the
materialized Keeper root. The latter must expose one exact restored SOL history
entry, keep stream/operator/chain readiness fail-closed while its loopback-only
dependencies are deliberately absent, reject the diagnostic publish route,
carry no signer authority, preserve logical SQLite and alert-state custody, and
exit cleanly. This does not substitute for dependency-ready staging or finalized
chain reconciliation.

## Reconcile the restored state with finalized Solana truth

Do not activate a restored Keeper database until a separate, read-only
reconciliation has re-verified the immediately preceding platform rehearsal and
restored-duel/application projection, then bound every retained SOL bet to the
approved public deployment. The verifier must be supplied with independently
approved cluster, genesis hash, program IDs, canonical ProgramData addresses,
upgrade authority, deployed slots, distinct role addresses, frozen configuration,
pause state, fee rates, and dispute window. These values must come from the release
record; the recovery tool must not infer or approve them.

The finalized reconciliation must, at minimum:

- open the restored Keeper database in SQLite read-only/query-only mode and prove
  that its integrity result, schema digest, logical digest, and complete table
  counts are unchanged across the observation;
- require every lifecycle checkpoint to remain available from the configured
  finalized-history provider, and bind every indexed placement signature to its
  finalized slot, success result, canonical transaction digest, program, and
  required account keys;
- independently derive every oracle duel, market, native-SOL vault, order, and
  user-balance PDA and compare the decoded finalized accounts with the restored
  participants, immutable competitive snapshot, terminal proof, market outcome,
  order sequence/state, and lifecycle disposition;
- enumerate all market-owned balances and orders rather than trusting only the
  restored bet rows; and
- reconcile the native-SOL vault against rent reserve, all active remaining-order
  collateral, all open/locked/cancelled balance liabilities, resolved winning
  shares, and escrowed fee accruals. Any omitted liability, fee drift, unexpected
  account, or undercollateralization is a hard failure.

Take two finalized chain observations around the two database inspections. Their
semantic projections must be identical even when the observation slots advance;
the final evidence records the bounded slots separately. The verification path
must have neither database nor chain mutation authority and must always record
`productionCutoverAuthorized=false` and
`activationRequiresSeparateApproval=true`.

The production collector and pure reconciliation contract are exercised by this
owned-local qualification:

```bash
bun run --cwd packages/hyperbet-solana/keeper test:finalized-solana-recovery
```

The retained 2026-08-26 owner-only artifact is
`artifacts/sol-finalized-recovery-reconciliation-20260826/evidence.json`, SHA-256
`34e71bf9bc777bf73e6de1dfda3bb67f13fbab6dd1e7b6323cd8631f429c71f7`.
It uses the current rebuilt SBF programs on an owned validator, the production
read-only collector, a real finalized placement transaction, production Keeper
schema/indexing/accounting functions, double reads, and an exact zero-excess
custody equation. It proves the technical collector and invariants without an
external network or real value. It does not prove the approved public genesis,
deployed program/config/role identities, archival RPC retention, the exact prior
production recovery artifacts, dependency-ready staging, production RPO/RTO, or
cutover approval.

For an isolated staging or production-shaped rehearsal, first create
`finalized-solana-recovery-expectation.json` under a mode-0700 evidence parent as
a mode-0600 regular file. It must use the strict schema
`operator_supplied_finalized_solana_recovery_expectation` and contain one exact
cluster/genesis/program/upgrade-authority/config/role/fee/dispute/pause
expectation, a canonical UTC creation time, and the change/release reference from
which the operator copied those values. It must also state
`independentApprovalEvidenceRequired=true`,
`activationRequiresSeparateApproval=true`, and
`productionCutoverAuthorized=false`. The file is an expectation input, not proof
that its values were approved. Calculate its SHA-256 independently. Separately
calculate the SHA-256 of `restored-duel-state-reconciliation.json`; do not copy
either digest from a proposed command or unverified manifest.

Inject the finalized-history RPC URL through the dedicated environment variable
named by `--rpc-url-env`; never place it on the command line or in retained
evidence. The command accepts HTTPS, or HTTP only for the exact loopback IPs used
by owned tests, rejects URL credentials/fragments, applies the supplied bounded
timeout to every RPC request, redacts the exact endpoint from failures, and never
retains it. Then run:

```bash
bun run --cwd packages/hyperbet-solana/keeper finalized-solana-recovery create \
  --keeper-backup="$KEEPER_BACKUP_PATH" \
  --keeper-evidence="$KEEPER_BACKUP_EVIDENCE_PATH" \
  --operator-alert-backup="$OPERATOR_ALERT_STATE_BACKUP_PATH" \
  --operator-alert-evidence="$OPERATOR_ALERT_STATE_EVIDENCE_PATH" \
  --keeper-recovery-set-manifest="$KEEPER_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-backup="$HYPERIA_BACKUP_CONTAINER_PATH/active/hyperia-postgres.dump" \
  --hyperia-evidence="$HYPERIA_BACKUP_CONTAINER_PATH/active/evidence.json" \
  --hyperia-migrations-directory="$HYPERIA_REPOSITORY/packages/server/src/database/migrations" \
  --platform-manifest="$PLATFORM_RECOVERY_SET_MANIFEST_PATH" \
  --hyperia-restore-evidence="$HYPERIA_RESTORE_EVIDENCE_PATH" \
  --hyperia-application-readiness="$HYPERIA_APPLICATION_READINESS_PATH" \
  --materialized-root="$RESTORED_KEEPER_CONTAINER_PATH/active" \
  --rehearsal-manifest="$PLATFORM_RECOVERY_REHEARSAL_MANIFEST_PATH" \
  --reconciliation-manifest="$RESTORED_DUEL_RECONCILIATION_MANIFEST_PATH" \
  --hyperia-release-sha="$HYPERIA_RELEASE_SHA" \
  --hyperia-database="$HYPERIA_DATABASE" \
  --hyperbet-release-sha="$RELEASE_SHA" \
  --cluster="$SOLANA_CLUSTER" \
  --operator-alert-route-id="$HYPERBET_OPERATOR_ALERT_ROUTE_ID" \
  --boundary-id="$RECOVERY_BOUNDARY_ID" \
  --tool-timeout-ms="$RECOVERY_TOOL_TIMEOUT_MS" \
  --query-timeout-ms="$RECOVERY_QUERY_TIMEOUT_MS" \
  --pg-restore-executable=pg_restore \
  --psql-executable=psql \
  --chain-expectation="$FINALIZED_CHAIN_EXPECTATION_PATH" \
  --chain-expectation-sha256="$FINALIZED_CHAIN_EXPECTATION_SHA256" \
  --restored-reconciliation-sha256="$RESTORED_DUEL_RECONCILIATION_SHA256" \
  --rpc-url-env=HYPERBET_RECOVERY_RPC_URL \
  --rpc-timeout-ms="$RECOVERY_RPC_TIMEOUT_MS" \
  --finalized-evidence="$FINALIZED_SOLANA_RECOVERY_EVIDENCE_PATH"
```

The output filename must be `finalized-solana-recovery-evidence.json` under an
existing mode-0700 parent. Creation refuses overwrite, re-verifies the entire
prior recovery graph before and after collection, rebinds both supplied input
digests, creates mode-0600 evidence, and immediately reruns verification. An
independent operator must rerun the exact command with `verify`. Verification
permits finalized observation slots to advance but rejects slot regression or
any semantic change to the database, deployment, accounts, transactions,
lifecycle state, or custody equation. Both actions remain read-only and return
no activation authority.

The operator orchestration is implemented and locally adversarially tested, but
it has not been executed against approved public values, the actual retained
production recovery set, or redundant archival providers. Until that execution,
independent evidence review, dependency-ready staging, witnessed RPO/RTO, and
explicit cutover decision are complete, this gate remains open for launch.

## Release rollback decision matrix

Rollback means different things at each layer. Never roll every layer back as
one blind action.

- **Pages/public app:** promote only a previously retained artifact whose source
  SHA, cluster, API schema, stream-source contract, program registry, legal
  policy, and transaction rail still match current authority. Validate it first
  in transaction-disabled preview.
- **Hyperbet service/duel bot:** treat the two Railway services as one release
  pair. Stop privileged work, capture and independently verify one paired SQLite
  plus operator-alert recovery set, and prove the rollback binary reads both
  schemas without mutation or loss. Record the exact active and rollback
  deployment IDs for both services and confirm each rollback remains retained
  before mutation. Roll both back to the recorded matching release through the
  platform deployment history; do not use a latest-version redeploy as an
  arbitrary rollback. Re-audit roles and custom variables, run the exact
  release/role/cluster/program verifier, and reconcile chain, terminal,
  incident, and pending-delivery custody before starting one writer or restoring
  public authority. Follow the paired procedure in
  [`hyperbet-production-deploy.md`](../hyperbet-production-deploy.md#two-service-release-and-recovery-boundary).
- **Hyperia server/authority:** stop the fenced authority, capture a new
  PostgreSQL backup, and prove the rollback release accepts every applied
  migration and current durable record. Prefer a forward fix when database or
  protocol compatibility is not proven.
- **Capture/encoder/stream delivery:** use the dedicated stream failover runbook;
  never change the authoritative duel/feed identity to recover video.
- **Solana programs:** a program rollback is a new on-chain upgrade, not a
  database restore. It requires the approved cold upgrade authority, exact
  previous SBF/IDL/source evidence, local and staging simulation, account-layout
  compatibility, independent review, and post-upgrade ProgramData/hash checks.
- **Frozen on-chain config:** a database backup cannot change it. Emergency
  pause/cancel behavior must use the separately approved and rehearsed
  cold-authority procedure; user claim/refund paths must remain available as the
  program permits.

If the previous release cannot read the current database, account layout,
protocol, or feed schema exactly, do not roll back that layer. Remain contained
and produce a reviewed forward fix.

## Recovery and resume criteria

- the PostgreSQL backup, keeper SQLite pair, and operator-alert state pair
  independently verify, the platform recovery manifest binds them to one
  boundary, the platform rehearsal manifest binds both verified restored
  states back to that set, the restored-duel reconciliation proves exact
  database-to-database semantic agreement plus the exact production public-
  history read projection, and the separate restore meets the approved
  recovery-point and recovery-time objectives;
- restored off-chain facts reconcile exactly to finalized Solana state without
  database edits or synthetic events;
- release, build, program, IDL, schema, config, role, fee, stream, and cluster
  identities are exact;
- one authority and one duel bot recover monotonically with no duplicate work;
- terminal custody, execution-fee escrow, refunds, claims, and owned liquidity
  reconcile exactly;
- public transaction authority remains disabled until the normal staged
  promotion gate and required approvals pass;
- the independent verifier signs the evidence package and every rehearsal-owned
  resource is accounted for.
