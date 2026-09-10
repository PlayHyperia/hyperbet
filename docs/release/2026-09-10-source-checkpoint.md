# SOL launch source checkpoint — 2026-09-10

This is a work-in-progress source checkpoint, not production approval, a deployment,
or evidence that the full launch experience passes. The parent revision is
`63a472388be9ee1ec1f6e2a3c1187dfbd640662a` on `codex/sol-only-launch`.

## Included work and exclusions

The checkpoint retains the existing SOL-only app and spectator UI, keeper lifecycle
and recovery controls, wallet/transaction authority checks, Anchor programs and
shared IDLs, deployment safeguards, tests, and operating runbooks. No real-value
production rail is enabled by this checkpoint.

Dependency caches, numbered file-provider duplicates, backup copies, local
databases, environment secrets, private keys, temporary test files, and retained
videos/reports are excluded. Local `pnpm-lock.yaml` and `pnpm-workspace.yaml` are
left unstaged: the reviewed launch graph explicitly uses Bun, and the local pnpm
workspace file contains unconfigured build-policy placeholders. No excluded file
was deleted. A stale zero-byte worktree index lock dated August 23 was moved to a
recoverable local checkpoint directory after verifying that no process owned it.

### Generated-code deletions

The 18 deleted app files are generated event-type codecs: 13 under
`src/generated/duel-market/types` and five under `src/generated/fight-oracle/types`.
Their corresponding barrel exports were removed. A separate read-only review found
61 remaining generated TypeScript files, 128 relative dependencies, and no missing
targets or source consumers of the removed modules/codecs. All 18 event schemas
remain in current canonical IDLs; the keeper decodes logs through Anchor's event
coder. Twelve canonical-to-app/keeper/UI JSON and TypeScript artifact comparisons
matched byte-for-byte.

This is coherent generated-code cleanup, not removal of protocol events. Exact
Coda regeneration was not reproduced during this checkpoint. The new sanitizer
only trims whitespace; it is not credited with deleting these files.

## Verification performed

Runtime: Node 22.23.2, Bun 1.3.14. Existing dependencies were used; no reinstall or
dependency upgrade was performed for this checkpoint.

- 125 Node tests passed across the 18 test files listed below.
- 79 Bun tests passed across the 14 files listed below, with 303 assertions.
- App source typecheck passed using the installed TypeScript compiler and
  `packages/hyperbet-solana/app/tsconfig.json` (includes `src` and `vite.config.ts`).
- Keeper, UI, SDK, Anchor-test, and scenario typechecks each exceeded a bounded
  90-second check without diagnostics and were terminated. They are **incomplete,
  not passing**. Cloud-dataless installed declaration files were observed, including
  Anchor's package-local `@coral-xyz/anchor/dist/cjs/index.d.ts`; this is a plausible
  I/O cause, not a fully proven cause of every timeout.
- Current SOL dependency policy passed: seven manifests, 129 dependencies.
- Current GitHub Actions policy passed: five workflows and one composite action.
- Current Railway configuration policy passed: two configurations.
- Staged whitespace validation passed.

### Node test command

```sh
node --test \
  scripts/check-sol-dependency-policy.test.mjs \
  scripts/check-high-severity-audit.test.mjs \
  scripts/check-legacy-branding.test.mjs \
  scripts/ci-github-actions-policy.test.mjs \
  scripts/ci-solana-devnet-funding-policy.test.mjs \
  scripts/ci-solana-keeper-deploy-target.test.mjs \
  scripts/ci-solana-railway-config.test.mjs \
  scripts/solana-deployment-evidence.test.mjs \
  scripts/verify-solana-keeper-deployment.test.mjs \
  scripts/ci-solana-pages-deployment-output.test.mjs \
  scripts/ci-solana-pages-deploy-target.test.mjs \
  scripts/solana-pages-build-identity.test.mjs \
  scripts/solana-pages-bundle-manifest.test.mjs \
  scripts/verify-solana-pages-deployment.test.mjs \
  scripts/resolve-pages-deployment-url-with-scoped-auth.test.mjs \
  scripts/run-railway-with-scoped-auth.test.mjs \
  scripts/run-wrangler-with-scoped-auth.test.mjs \
  scripts/ci-env-audit-solana-v1.test.mjs
```

### Bun test command

```sh
bun test \
  scripts/ci-env-audit-solana-v1-policy.test.ts \
  scripts/ci-keeper-runtime-env-solana-v1-policy.test.ts \
  scripts/ci-solana-mainnet-program-verification-policy.test.ts \
  packages/hyperbet-solana/keeper/src/duelLifecycleTiming.test.ts \
  packages/hyperbet-solana/keeper/src/feePolicy.test.ts \
  packages/hyperbet-solana/keeper/src/publicPreparation.test.ts \
  packages/hyperbet-solana/keeper/src/realValueLaunchPolicy.test.ts \
  packages/hyperbet-solana/keeper/src/solanaLifecycleMarketIdentity.test.ts \
  packages/hyperbet-solana/keeper/src/solanaLifecyclePendingPolicy.test.ts \
  packages/hyperbet-solana/keeper/src/streamStateCandidatePolicy.test.ts \
  packages/hyperbet-solana/keeper/src/streamStateHeartbeat.test.ts \
  packages/hyperbet-solana/keeper/src/terminalMarketCustody.test.ts \
  packages/hyperbet-solana/keeper/src/oracleDisputeWindowPolicy.test.ts \
  packages/hyperbet-solana/keeper/src/transactionRecovery.test.ts
```

## Secret-scan qualification

Gitleaks 8.30.1 with default rules reported three findings in the staged source.
Source review classified all three as noncredentials:

1. `DUEL_KEY_HEX` in `.storybook/mocks/programs.ts`: a public, synthetic 32-byte
   duel identifier passed to PDA derivation, not a signing key.
2. The same public identifier in `STORYBOOK_DUEL_KEY` in `.storybook/preview.tsx`.
3. The browser test's fixed `hyperbet.e2e.pending-wallet-signature` storage-key
   **name**, not a wallet signature value or credential.

`.gitleaks.toml` extends all default rules. Each exception applies only to
`generic-api-key`, with `condition = "AND"`, an exact repository-relative path,
and an anchored full matched assignment including its exact reviewed literal.
There are no whole-file, directory, commit, or general identifier waivers.
The configured staged scan reported no remaining findings.

An isolated synthetic-fixture scan confirmed that four negative cases are still
detected: a different credential-shaped value in the same Storybook file, an
entropy-preserving change to the public duel literal, the original literal at a
different path, and a changed browser storage-key name. An initial single-character
drift fixture fell below the default rule's entropy threshold; the final drift
fixture preserves entropy. Secret scanning is not a proof that no possible secret
exists. The new committed revision range must also be scanned before pushing.

## Gates still open

- Complete all five interrupted typechecks with fully available dependencies.
- Reproduce generated clients and prove clean regeneration.
- Run the full applicable app/UI/keeper/SDK/Anchor suites, current localnet and
  real-game wagering E2E, browser visual/accessibility checks, performance budgets,
  outage/recovery qualification, and sustained operation gates.
- Preserve the production real-value block until independently reviewed program,
  signer, custody, operational, and end-to-end launch evidence is complete.
- Review and merge the checkpoint through the normal PR process; this document
  does not grant merge, deployment, or mainnet authorization.
