# Hyperbet Solana Deployment

This runbook covers the v1 Solana deployment only. Deployment is not approval to launch real-value wagering; legal, compliance, security-audit, incident-response, and operational sign-offs remain independent gates.

## Topology

- Cloudflare Pages serves `packages/hyperbet-solana/app`.
- Railway runs two isolated services from the same commit-pinned, pruned image in `packages/hyperbet-solana/keeper`.
- The public service uses `HYPERBET_RUNTIME_ROLE=service` and owns only the read-only HTTP/streaming surface. It must not receive signing keys.
- The private service uses `HYPERBET_RUNTIME_ROLE=duel-bot`, consumes Hyperia's authenticated schema-v3 betting feed, and performs authorized Solana lifecycle work. It must not have a public domain.
- The API authenticates to the bot's Railway-private `/health/snapshot` endpoint. The processes must report the exact expected release SHA, `service`/`duel-bot` roles, cluster, fight-oracle program, and duel-market program before `/ready` can pass.
- The API derives Hyperia's exact same-origin `/api/streaming/health` endpoint from `STREAM_STATE_SOURCE_URL`, consumes only its normalized schema-v1 numeric projection, and federates that projection with keeper custody metrics. Raw upstream health bodies, URLs, credentials, and exception text are not republished.
- `deployments/solana-v1.json` is the canonical program registry.
- The only launch programs are `fight_oracle` and `duel_market`.

## Active workflows

- `deploy-solana-pages.yml`: manually builds, scans, deploys, and verifies Pages metadata.
- `deploy-solana-keeper.yml`: manually audits configuration, runs the launch keeper suite, proves retired routes return 404, stages the exact transitive SOL runtime closure, waits for the bot and API's health-gated Railway deployments in that order, and then runs the strict public deployment verifier.
- `deploy-testnet-v3.yml`: manual, explicitly confirmed two-program devnet deployment and frozen configuration.

No merge or push automatically deploys the app, API, bot, or on-chain programs. Production dispatch requires `DEPLOY_SOL_PRODUCTION`, a full lowercase commit SHA, the `main` ref, and an exact checked-out SHA match. Staging is the manual default.

Every third-party action in all five callable workflows and their shared composite action is pinned to one reviewed 40-character commit from an official signed release: `actions/checkout` v6.0.2, `actions/setup-python` v6.3.0, `actions/upload-artifact` v7.0.1, `oven-sh/setup-bun` v2.2.0, `actions/cache` v5.0.4, and `dtolnay/rust-toolchain` v1. The only local action reference is the exact repository path `./.github/actions/setup-hyperbet`. The dependency-free `scripts/ci-github-actions-policy.mjs` gate audits the exact five-workflow plus one-composite-action source set, every invocation, the approved action/revision/version-label allowlist, and exact invocation counts. It rejects floating tags or branches, short or uppercase SHAs, unreviewed commits/actions, misleading version labels, ambiguous syntax, new action sources, and local path drift or traversal.

All nine workflow jobs select the explicit GitHub-hosted `ubuntu-24.04` x64 label rather than `ubuntu-latest`. The shared setup action independently requires `RUNNER_OS=Linux`, `RUNNER_ARCH=X64`, `ImageOS=ubuntu24`, and a canonical GitHub `ImageVersion`, then writes that non-secret image version to the job log before any tool setup. GitHub documents `ubuntu-24.04` as a supported standard-runner label and recommends an explicit OS label to avoid an unwanted `-latest` migration; see the official [runner-selection documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job) and [`actions/runner-images` label policy](https://github.com/actions/runner-images#available-images). This fixes the OS generation, not the exact hosted image bytes: GitHub continues publishing patched Ubuntu 24 images. Record `ImageVersion` and the job's `Set up job` image-release identity for every release run, compare them across jobs, and treat an unexplained mismatch or unavailable image record as a hold.

The Python SDK job selects exact CPython `3.12.14` x64 with `check-latest: false` through the commit-pinned setup-python action, then independently verifies the action output, active executable path, patch version, CPython implementation, and 64-bit pointer width before package installation. The action's GitHub token use is explicit rather than inherited from its default: only the setup-python step receives `${{ github.token }}` under the workflow's read-only `contents` permission so the action can fetch the exact public `actions/python-versions` distribution without anonymous API-rate ambiguity. The token is not passed to pip, Poetry, SDK commands, later workflow steps, or checkout persistence. setup-python's pip cache is disabled because it restores executable package bytes. Poetry `1.8.5` is fetched with pip's cache and version-check behavior disabled, checked by exact CLI version plus `pip check`, and its complete installed graph is written to the job log. The SDK environment installs with `poetry install --sync` from the checked-in lock before re-verifying Python `3.12.14`. The SDK lock records package hashes; Poetry's own pip-resolved transitive tool environment is not yet a hash-locked release artifact, so retain its installed-package evidence and treat independent registry/provenance review as open rather than claiming complete Python supply-chain closure. Official setup-python guidance recommends an exact patch to prevent silent patch updates, and the current official [`actions/python-versions` manifest](https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json) lists the Ubuntu 24 x64 `3.12.14` distribution. Version, path, and implementation self-reporting do not cryptographically authenticate that downloaded distribution; authoritative release-asset digest or signed-provenance review and a clean hosted run remain separate production gates.

The reviewed upstream identities are:

- [`actions/checkout` v6.0.2 signed release](https://github.com/actions/checkout/releases/tag/v6.0.2), commit [`de0fac2e4500dabe0009e67214ff5f5447ce83dd`](https://github.com/actions/checkout/commit/de0fac2e4500dabe0009e67214ff5f5447ce83dd)
- [`actions/setup-python` v6.3.0 signed release](https://github.com/actions/setup-python/releases/tag/v6.3.0), commit [`ece7cb06caefa5fff74198d8649806c4678c61a1`](https://github.com/actions/setup-python/commit/ece7cb06caefa5fff74198d8649806c4678c61a1)
- [`actions/upload-artifact` v7.0.1 signed release](https://github.com/actions/upload-artifact/releases/tag/v7.0.1), commit [`043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`](https://github.com/actions/upload-artifact/commit/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a)
- [`oven-sh/setup-bun` v2.2.0 signed release](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0), commit [`0c5077e51419868618aeaa5fe8019c62421857d6`](https://github.com/oven-sh/setup-bun/commit/0c5077e51419868618aeaa5fe8019c62421857d6)
- [`actions/cache` v5.0.4 signed release](https://github.com/actions/cache/releases/tag/v5.0.4), commit [`668228422ae6a00e4ad889ee87cd7109ec5666a7`](https://github.com/actions/cache/commit/668228422ae6a00e4ad889ee87cd7109ec5666a7)
- [`dtolnay/rust-toolchain` v1 signed release](https://github.com/dtolnay/rust-toolchain/releases/tag/v1), commit [`6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772`](https://github.com/dtolnay/rust-toolchain/commit/6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772)

All nine checkout steps set the literal `persist-credentials: false` input and receive no `token` or `ssh-key` override. None of these workflows performs an authenticated Git operation after checkout, so later build, test, deployment, or repository scripts have no reason to inherit the workflow GitHub credential. The source policy validates this per checkout block rather than relying on a repository-wide string count. The pinned checkout documentation confirms that credential persistence is enabled by default and that this input opts out; see the exact [v6.0.2 checkout documentation](https://github.com/actions/checkout/blob/de0fac2e4500dabe0009e67214ff5f5447ce83dd/README.md#usage).

The shared setup action passes `token: ""` to setup-bun. The exact Bun `1.3.6` input takes the pinned action's direct semantic-version path and does not require the GitHub tag API, so the third-party action receives no workflow token. Its executable cache is disabled. Cargo caching is restricted to registry and Git source data—never `~/.cargo/bin`—and the Solana executable is not restored from Actions cache. Bun, rustc, Cargo, Solana, Anchor, and cargo-audit are checked against the exact requested versions after setup; Rust is fixed at `1.93.1`.

Anchor `0.32.1` is built from exact signed-release commit [`1ebbe58158d089a2a40b5e35ebead5a10db9090d`](https://github.com/otter-sec/anchor/commit/1ebbe58158d089a2a40b5e35ebead5a10db9090d) using Cargo `--rev`, `--locked`, and a post-install version check; a tag is not accepted. The corresponding [v0.32.1 release](https://github.com/otter-sec/anchor/releases/tag/v0.32.1) records that exact verified commit. cargo-audit uses an exact `=0.22.2` registry requirement, Cargo's locked registry checksum verification, and an independent post-install version check.

Agave/Solana `2.3.0` is restricted to the reviewed Linux X64 runner target. Its HTTPS installer is downloaded to a unique mode-private bounded file rather than streamed into a shell; HTTPS-only redirects, TLS 1.2+, a 120-second timeout, and a one-MiB size ceiling are mandatory, and the file is removed on every exit. After installation, the action requires exact CLI version `2.3.0` and byte-exact `version.yml` identity for signed-release commit [`a2e21dda295b18dd09ac06542834c5e9b1b2dc84`](https://github.com/anza-xyz/agave/commit/a2e21dda295b18dd09ac06542834c5e9b1b2dc84) and target `x86_64-unknown-linux-gnu`; the [v2.3.0 release](https://github.com/anza-xyz/agave/releases/tag/v2.3.0) records that verified commit. This is stronger identity and transport validation, but it is not a cryptographic check of the downloaded installer or release archive itself. Promotion remains held until an authoritative asset digest or equivalent signed provenance is pinned and exercised on the hosted runner.

All nine local-action callers may request only unique literal-true install capabilities; they cannot override any toolchain version or revision. Composite run scripts receive inputs through step environment variables rather than interpolating expressions into Bash source.

Workflow source must not use `bunx`, `npx`, `pnpm dlx`, or `yarn dlx`, because those package auto-resolvers can fetch an executable when the intended lockfile installation is missing or drifted. The keeper launch typecheck invokes the exact root `./node_modules/.bin/tsc` installed from the frozen dependency graph, and the independent scope gate requires root TypeScript `5.9.3`, exactly one canonical invocation, and zero package auto-resolver calls. A missing local executable must fail the job rather than silently selecting a registry package.

An action, runner-generation, or language-runtime upgrade is a reviewed release change. Verify the tag's full commit on the official action repository and its signed-release status; update every invocation, exact version label, runner/runtime label, policy allowlist/count, negative tests, and release memo together. Never update a floating major tag in place, and never treat a green action run as proof that an unreviewed action revision, hosted image, or downloaded runtime distribution is trustworthy.

## Deployment verification certificates

Successful staging and production workflows create one exact-schema, mode-0600 post-deployment certificate only after the network verifier passes. The Pages certificate binds the release, rail, cluster, deployment-configuration digest, complete-bundle digest, exact build-info digest, verified-origin count, and GitHub run identity. The keeper certificate binds the release, rail, cluster, public origin, approved fight-oracle and duel-market programs, exact endpoint count, and the same run identity. Both certificates carry a canonical payload digest, reject unknown fields, and state `productionActivationAuthorized: false`; neither certificate contains credentials, provider responses, environment dumps, private URLs, wallets, signers, or private strategy.

Each workflow uploads exactly one certificate with commit-pinned `actions/upload-artifact` only after successful verification. GitHub's artifact record supplies a separate artifact ID, URL, and SHA-256 digest. The runner copy is mode 0600; GitHub's default archived upload does not preserve file modes, so the archive owner must restore the approved access mode after download. The configured 30-day workflow retention is transport, not the approved launch-retention policy: before sign-off, the release owner must copy the certificate into the approved immutable release archive, independently recompute its file and payload digests, record the GitHub artifact ID/digest and archive identity in the release memo, and verify the archived bytes again. A missing, expired, mismatched, or unarchived certificate is a hold. Preview deployments deliberately do not create a network-verification certificate because they do not prove the configured staging/production origin. Current upload inputs, digest outputs, immutability, retention, and permission behavior are documented by the official [`actions/upload-artifact` project](https://github.com/actions/upload-artifact).

## Pages configuration

Required GitHub variables depend on the selected environment:

- `HYPERBET_SOLANA_PAGES_PROJECT_NAME`
- `HYPERBET_SOLANA_PAGES_PRODUCTION_URL`
- `HYPERBET_SOLANA_KEEPER_URL`
- `HYPERBET_SOLANA_KEEPER_WS_URL`
- corresponding `*_STAGING_*` values for staging

Required secret:

- `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_WRANGLER_CONFIG_B64`

The build sets `VITE_SOLANA_CLUSTER=mainnet-beta` and routes RPC through the keeper. Provider credentials must never be placed in public build variables.

## Keeper configuration

Deployment routing requires the configured Railway project, environment, public API service, private duel-bot service, public URL, and `RAILWAY_TOKEN`. Runtime configuration is documented in [`packages/hyperbet-solana/keeper/.env.example`](../packages/hyperbet-solana/keeper/.env.example).

Required GitHub variables include the production and staging values for:

- `HYPERBET_SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256`
- `HYPERBET_SOLANA_RAILWAY_PROJECT_ID`
- `HYPERBET_SOLANA_RAILWAY_PRODUCTION_ENVIRONMENT_ID`
- `HYPERBET_SOLANA_RAILWAY_KEEPER_SERVICE_ID`
- `HYPERBET_SOLANA_RAILWAY_DUEL_BOT_SERVICE_ID`
- the corresponding `*_STAGING_*` environment, API-service, and duel-bot-service IDs

The checked-in registry deliberately records `realValueProgramVerification.status=unverified` until a fresh mainnet pair has passed the independent program-deployment verification procedure. While that status is present, the production keeper target fails before producing deployment environment output, even if the manual confirmation and every infrastructure variable are supplied. The direct `keeper:duel:mainnet` and `test:e2e:mainnet` commands stop at the same preflight before starting a keeper or browser. After the authorized deployment and independent verification, bind the retained evidence's lowercase SHA-256 digest into the registry with status `verified`, place that exact digest in the protected GitHub variable above, and configure the same digest as `SOLANA_MAINNET_PROGRAM_VERIFICATION_SHA256` on both Railway services. Registry status, protected workflow value, and both runtime values must agree. A digest match does not itself authorize betting: executable program accounts, ProgramData linkage, upgrade authorities, frozen configuration, roles, economics, readiness, and the separate public transaction-activation gates must still pass.

Configure the API service with `HYPERBET_RUNTIME_ROLE=service`, an authenticated Railway-private `KEEPER_BOT_HEALTH_URL`, and `KEEPER_BOT_HEALTH_BEARER_TOKEN`. Configure the bot service with `HYPERBET_RUNTIME_ROLE=duel-bot` and the same token. Use at least 32 random characters and rotate the token as a secret. The API URL must be exactly `/health/snapshot`; private HTTP is accepted only for a `*.railway.internal` hostname. The bot's independent `KEEPER_BOT_HEALTH_HEARTBEAT_MS` cadence performs a real SOL RPC probe and must remain below `READINESS_BOT_MAX_AGE_MS`; the defaults are 5 seconds and 30 seconds, respectively.

Production must provide:

- the exact independently retained mainnet program-verification evidence digest on both services
- canonical HTTPS `STREAM_STATE_SOURCE_URL`
- Solana RPC/provider configuration
- explicit expected upgrade authorities for both programs
- lifecycle-index deployment start slot
- fail-closed readiness thresholds
- database persistence
- a private duel-bot service and authenticated health transport

The service polls Hyperia's numeric health projection with the same bounded timeout, origin, and bearer credential as the canonical stream-state source. Production `/ready` is fail-closed unless both ordinary service readiness and the federated operator projection are ready. `/api/operator/readiness` is the narrow monitoring target: it returns HTTP 200 only when the service, Hyperia stream runtime, keeper feed, terminal ledger, and claim-timing invariants are all current and safe; otherwise it returns HTTP 503 with bounded alert codes. Point alerting at this endpoint rather than scraping raw upstream payloads.

The API service also owns one transition-aware webhook dispatcher for that exact federated projection. Production mainnet requires `HYPERBET_OPERATOR_ALERT_WEBHOOK_URL`, `HYPERBET_OPERATOR_ALERT_ROUTE_ID`, and explicit monitor, reminder, retry, and timeout values from `.env.example`. The route must use HTTPS; optional bearer authorization stays in the request header. Payloads contain only the fixed alert codes, source classes, bounded source ages, timestamps, an incident fingerprint, and a stable delivery ID. They never include the webhook URL, bearer token, upstream exceptions, RPC details, wallets, signer material, bank state, or private strategy. Before each request, the dispatcher atomically persists a mode-0600 pending delivery; both its payload and `Idempotency-Key` header carry the stable delivery ID. It acknowledges provider acceptance only after atomically persisting the resulting incident state. A crash, ambiguous provider response, or post-acceptance persistence failure therefore replays the same delivery ID before any newer observation. Accepted firing custody, reminders, and recovery intent survive replacement-process restarts. Corrupt state or a route-ID mismatch fails startup rather than silently losing incident custody. The dispatcher otherwise suppresses duplicates, sends bounded reminders, retries failures, emits recovery only after an accepted firing notification, and lets an in-flight request finish within its configured timeout during `SIGINT` or `SIGTERM`. `/api/operator/readiness` exposes only redacted delivery counters and a fixed failure code.

Before production promotion, send controlled unhealthy and recovery events through the real provider route. Retain provider acceptance, downstream paging/escalation acknowledgement, timing, receiver identity, and redacted payload evidence. Local loopback and HTTP acceptance tests do not prove provider delivery or human escalation.

After configuring the approved route on an operator workstation, verify HTTP acceptance with the exact release SHA before running the firing/recovery drill:

```bash
HYPERBET_OPERATOR_ALERT_TEST_APPROVED=true \
  bun run --cwd packages/hyperbet-solana/keeper operator-alert-probe -- \
  --environment=staging \
  --release-sha=<40-character-release-sha> \
  --output=<new-private-evidence-path.json>
```

The command reuses the production HTTPS, route-ID, bearer, redirect, and timeout policy; sends one explicitly non-actionable, no-value test event; and atomically creates a mode-0600 evidence file without overwrite. The evidence never stores the webhook URL, query secret, bearer token, provider body, or exception. A successful artifact proves HTTP acceptance only and deliberately records that provider acknowledgement plus a controlled firing/recovery test are still required. Hash the artifact, capture the provider event ID and downstream acknowledgement separately, and never pass the webhook or bearer value on the command line.

The release image runs as UID/GID 1000 (`bun`), keeps code and dependencies read-only, and writes only beneath `/app/data`. Mount persistent storage at `/app/data` for both service roles and verify it is writable by UID/GID 1000 before promotion. The canonical database and status paths are `/app/data/keeper.sqlite`, `/app/data/status/keeper-bot-health.json`, `/app/data/status/stream-state.json`, and `/app/data/status/operator-alert-state.json`; do not redirect them into the application source tree. Back up and restore the operator-alert state with the service database by following the paired, quiescent procedure in [Backup, Restore, And Release Rollback](runbooks/backup-restore-and-release-rollback.md). Never delete it during an active incident. A deliberate route handoff requires an approved, witnessed custody procedure because a different route ID is rejected rather than inheriting or discarding the prior route's state.

The HTTP service must not receive any keeper/config private key. Automated writer keys belong only to the private duel-bot service and must use distinct identities for fee payer, reporter, finalizer, market operator, and liquidity provider. The challenger is public-only. Railway readiness for the bot uses unauthenticated `/ready`, which returns only minimal process/release state; the full snapshot remains token-protected and private.

## Two-service release and recovery boundary

The API and duel bot are one release pair even though Railway deploys them as two services. The workflow serializes deployments without cancelling an in-progress run, validates both committed Railway configurations exactly, waits for the bot's health-gated deployment, then waits for the API's health-gated deployment. It does not use detached deployment success as release evidence.

Before dispatching a production release, the release owner and independent verifier must record:

- the exact approved release SHA, cluster, fight-oracle program, and duel-market program;
- the current API and duel-bot Railway deployment IDs and their exact matching live release/runtime identities;
- whether both retained deployments are still eligible for platform rollback;
- the paired keeper databases and operator-alert recovery state required by [Backup, Restore, And Release Rollback](runbooks/backup-restore-and-release-rollback.md);
- database/schema compatibility of the approved rollback release; and
- the owner, evidence directory, containment decision, and maximum allowed interruption window.

Do not place Railway tokens, environment values, signer material, private URLs, or backup contents in the release evidence. Keep public transaction authority disabled until the new pair passes the complete promotion gate. A brief fail-closed API-readiness interval can occur after the new bot becomes healthy but before the matching API is promoted; it is not permission to bypass the exact release check.

If either deployment or the strict verifier fails:

1. Stop the rollout. Do not dispatch another workflow, use `railway redeploy`, or repeatedly run `railway up` as an attempted rollback. Those actions target the latest deployment rather than selecting the approved prior pair.
2. Keep transaction authority, quoting, and privileged lifecycle writes disabled under the approved incident procedure. Record which bot and API deployment IDs are active and which exact release/runtime identities each endpoint reports.
3. Prove the approved prior release can read the current schemas and retained state without mutation or loss. If it cannot, remain contained and produce a reviewed forward fix.
4. Use Railway's deployment history to roll both services back to their individually recorded, matching last-known-good deployments. Treat this as one witnessed pair operation; intermediate readiness failure is expected until both services match.
5. Re-audit the restored service variables and roles because a Railway rollback restores the selected deployment's code and associated custom-variable state. Do not assume current variables survived unchanged.
6. Run the strict verifier from the archived rollback release checkout with its independently recorded expectations:

   ```bash
   EXPECTED_KEEPER_RELEASE_SHA=<40-character-rollback-sha> \
     HYPERBET_KEEPER_URL=<approved-root-https-api-url> \
     DEPLOY_TARGET=<staging-or-production> \
     DEPLOY_SOLANA_CLUSTER=<devnet-or-mainnet-beta> \
     DEPLOY_FIGHT_ORACLE_PROGRAM_ID=<approved-fight-oracle-program> \
     DEPLOY_DUEL_MARKET_PROGRAM_ID=<approved-duel-market-program> \
     node scripts/verify-solana-keeper-deployment.mjs
   ```

7. Reconcile database, terminal queue, alert-delivery custody, active markets, claims, refunds, and finalized chain state. Restore public transaction authority only after the normal staged promotion gate and independent approval pass again.

The Railway CLI currently supports deploying and redeploying the latest service version, but selecting an arbitrary retained deployment for rollback is a deployment-history action. Confirm the chosen deployment is still retained and rollback-eligible before every release; never promise recovery from an image that the platform no longer retains. Railway health checks gate deployments rather than replacing runtime monitoring, so `/api/operator/readiness` and external alerts remain mandatory after promotion. See Railway's current [deployment commands](https://docs.railway.com/cli/deployment), [rollback guidance](https://docs.railway.com/guides/roll-back-bad-deploy), and [health-check behavior](https://docs.railway.com/reference/healthchecks).

## On-chain configuration

Before any deployment or initialization:

```bash
bun run ci:gate:registry:launch
bun run ci:scope:solana
bun run --cwd packages/hyperbet-solana deploy:preflight:mainnet
```

Initialization requires explicit role public keys, approved economics, an approved dispute window, an expected upgrade authority, and explicit freeze approval. Mainnet refuses initialization without `--freeze`.

Required approval/configuration fields include:

- `SOLANA_LAUNCH_FEE_POLICY_APPROVED=true`
- `SOLANA_LAUNCH_CONFIG_FREEZE_APPROVED=true`
- `SOLANA_ORACLE_DISPUTE_WINDOW_SECS`
- `TRADE_TREASURY_FEE_BPS`
- `TRADE_MARKET_MAKER_FEE_BPS`
- `WINNINGS_MARKET_MAKER_FEE_BPS`
- every `SOLANA_PM_*_PUBKEY` role
- exact program upgrade-authority expectations

No production economics have a code default.

## Promotion checks

Do not promote until all of these pass on the exact release SHA:

```bash
bun run ci:env
bun run ci:scope:solana
bun run ci:gate:registry:launch
bun run ci:gate:solana:build
bun run ci:gate:solana
bun run ci:gate:e2e:solana
bun run ci:prepr
```

Record the three exact third-party action commits, all nine checkout credential-isolation results, and the passing workflow supply-chain policy result in the release memo. A mismatch between the release checkout, policy output, and memo is a hold.

Then verify the deployed services:

- Pages' exact configuration identity, complete bundle manifest, custom origin, and `build-info.json` match the release SHA and selected deployment rail.
- `verify-solana-keeper-deployment.mjs` accepts the unredirected public API only when `/ready`, `/status`, and `/api/keeper/bot-health` report the exact manifest-sourced release, roles, cluster, and approved program pair with empty service and federated alerts.
- The strict verifier observes a fresh Solana parser snapshot for the same program pair, remote dedicated-bot transport, valid active-market/duel-context/leaderboard projections, and unredirected 404 responses for every retired route.
- `/api/operator/readiness` reports `operatorMetrics.alertDelivery.configured=true`, no fixed delivery-failure code, and no webhook URL or credential.
- the approved provider route has acknowledged one controlled firing event and its matching recovery on the exact release SHA.
- the canonical stream and active prediction-market endpoints agree on duel identity.
- bot health reports the Solana runtime and no recovery blockers.
- disabled product and alternate-runtime routes return HTTP 404.
- no source map or provider credential is present in the production bundle.
- both successful deployment certificates independently parse, their payload and GitHub artifact digests match the archived bytes, and the release memo records both artifact identities; the certificates' explicit no-activation classification remains unchanged.

Rollback the app/service release if readiness, source freshness, parser freshness, program identity, database checks, market recovery, or lifecycle indexing becomes unsafe. Pause quoting and privileged writes before attempting state repair.
