# Hyperbet Solana Release Memo

- Release identifier:
- Git SHA:
- Date/UTC window:
- Release owner:
- Program IDs and SBF hashes:
- App/service build identifiers:
- GitHub Action identities (`checkout`, `setup-python`, `upload-artifact`, `setup-bun`, `cache`, `rust-toolchain`) and action-source-policy result:
- GitHub-hosted runner label / `ImageOS` / `ImageVersion` / image-release identities for all nine jobs:
- Python SDK toolchain identity (CPython version/architecture, setup-python token/cache boundary, Poetry version and installed transitive graph, SDK lock/install result):
- Runtime toolchain identities (Bun/Rust/Solana/Anchor/cargo-audit versions, Agave/Anchor release commits, installer-integrity result):
- Pages deployment certificate SHA-256 / GitHub artifact ID and digest / immutable archive identity:
- Keeper deployment certificate SHA-256 / GitHub artifact ID and digest / immutable archive identity:

## Scope

State the exact user experience and confirm the two-program/native-SOL boundary.

## Verification

List every required command, pass count, duration, and artifact link. Include validator, exploit, keeper, UI, browser, build, scope, and staged evidence.

Record the exact 40-character commit and signed release label for every approved third-party GitHub Action. Attach the dependency-free policy result proving the exact five-workflow plus one-composite-action allowlist, 29 total invocations, 20 approved external invocations, nine exact local-action invocations, all nine jobs selecting `ubuntu-24.04`, all nine checkout steps using literal `persist-credentials: false` with no token/SSH-key override, setup-bun receiving an empty token with its executable cache disabled, exact Rust `1.93.1` selection, no cached Cargo/Solana executable state, exact lockfile-installed TypeScript `5.9.3` selection, zero package auto-resolver calls, and no tag, branch, short-SHA, unapproved-action, version-label, syntax, path, or runner-generation drift. Independently compare the recorded commits, action inputs, runner labels, and toolchain/cache controls with the action-source bytes in the release checkout. For every job, retain the validated Linux/X64 `ImageOS=ubuntu24`, canonical `ImageVersion`, and the `Set up job` image-release record. The fixed OS label is not an immutable image; unexplained cross-job image drift or missing image provenance is a hold.

Record Anchor `0.32.1` commit `1ebbe58158d089a2a40b5e35ebead5a10db9090d`, Agave `2.3.0` commit `a2e21dda295b18dd09ac06542834c5e9b1b2dc84`, the exact Linux X64 installed manifest, and cargo-audit's exact registry version. Confirm no local-action caller overrides a version/revision and no composite run block directly interpolates an input expression. A matching Solana version/manifest does not prove installer/archive bytes: attach the separately approved authoritative asset digest or signed-provenance result before promotion. Missing cryptographic installer evidence is a hold.

Record exact CPython `3.12.14` x64, the setup-python output/distribution identity, its one step-scoped read-only GitHub-token boundary, disabled package cache, runtime version/implementation/width checks, exact Poetry `1.8.5`, `pip check`, complete installed Poetry tool graph, synchronized SDK-lock install, SDK-environment Python identity, and lock/hash verification result. The Poetry entry-point version alone does not freeze pip-resolved transitive tool packages; missing transitive-package/provenance evidence is a hold.

Independently parse both exact-schema post-deployment certificates, recompute their canonical payload and file digests, match release/rail/cluster/run identity, verify their GitHub artifact digests against the archived bytes, and confirm both still state `productionActivationAuthorized: false`. Expiring workflow storage is not the release archive.

Record and independently verify the exact Hyperia PostgreSQL backup evidence, isolated-restore certificate, restored application-read projection certificate, same-boundary platform recovery-set manifest, cross-repository recovery-rehearsal manifest, restored duel/application reconciliation, actual Hyperia and Hyperbet restored-service startup qualifications, and finalized-chain reconciliation. The finalized-chain artifact must bind the exact preceding recovery artifacts, approved public genesis/program/config/role values, retained checkpoint history, indexed transaction digests, decoded account/PDA state, stable double reads, and the complete native-SOL vault-liability equation. State every artifact's SHA-256 and whether it is local diagnostic, production-shaped rehearsal, or production evidence. For each startup qualification, retain the executable/bundle and runtime identity, exact endpoint results, graceful-shutdown result, and permitted database-mutation set. A recovery manifest with `productionCutoverAuthorized: false` cannot authorize activation.

## On-chain and operational state

Record program identity, upgrade authority, frozen roles/fees/dispute window, lifecycle-index start slot, RPC retention, readiness, alerting, signer custody, approved RPO/RTO, restore-boundary identity, post-restore reconciliation, and rollback readiness.

## Risks and approvals

List open/accepted risks with owner, rationale, expiry, and approving authority. Attach security, operations, product, legal/compliance, and release decisions.

## Decision

- [ ] promote
- [ ] hold
- [ ] rollback

Decision rationale and UTC timestamp:
