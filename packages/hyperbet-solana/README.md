# Hyperbet Solana

> **TL;DR:** This package is the Solana phase-1 launch surface for user-facing `PM/CLOB duels` and `perps/models`, plus the internal `AMM` engine. Solana full-product deploy, init, freeze, and verify rails now include `lvr_amm`, but launch is still blocked until canonical mainnet AMM truth is committed to the shared chain registry.

## What Lives Here

- `anchor/programs/fight_oracle`: duel lifecycle and authoritative result flow
- `anchor/programs/gold_clob_market`: Solana PM/CLOB market
- `anchor/programs/lvr_amm`: internal AMM and liquidity engine
- `anchor/programs/gold_perps_market`: Solana perps market
- `app`: Solana app shell for duels and models
- `keeper`: Solana keeper and staged-proof canary implementation
- `scripts`: full-product preflight, init, freeze, and verify entrypoints

## Current Role In Phase-1

- launch-blocking chain: `yes`
- non-mainnet proving lane: `devnet`
- user-facing surfaces:
  - `PM/CLOB duels`
  - `perps/models`
- internal launch-critical surface:
  - `AMM`

## Key Commands

From `packages/hyperbet-solana`:

```bash
bun run deploy:preflight:devnet
bun run anchor:deploy:devnet
bun run deploy:init:devnet -- --freeze
bun run verify:deployment:devnet
```

Useful variants:

```bash
bun run deploy:preflight:testnet
bun run deploy:preflight:mainnet
bun run deploy:init:testnet
bun run deploy:init:mainnet
bun run verify:deployment:testnet
bun run verify:deployment:mainnet
```

## Development

### Keeper hosting migration

`keeper/cloudflare/runtime-manifest.json` pins the 24 verified live runtime files,
including the deployed contract registry. Fetch its Git commits before building
from a shallow checkout. From the repository root:

```bash
node packages/hyperbet-solana/keeper/cloudflare/prepare-runtime.mjs
node packages/hyperbet-solana/keeper/cloudflare/prepare-operations.mjs
node packages/hyperbet-solana/keeper/cloudflare/prepare-host.mjs
docker build --platform linux/amd64 -t keeper-cloudflare:local packages/hyperbet-solana/keeper/cloudflare
```

The preparation commands verify source hashes and refuse existing output paths.
The host preserves the service and bot source and replaces database calls with
authenticated HTTPS. Uncertain storage results stop their isolated process group;
durable owner IDs prevent stale database writes after a handoff. Imports
verify all 15 tables and remain inactive until separately activated.
The controller and administrative handlers require separate runtime/admin tokens,
explicit activation, and receipt/chain reconciliation after any process exit.
They never automatically restart a financial owner. `cloudflare/wrangler.toml`
binds one container to the same SQLite Durable Object and defaults to inactive.
Set separate `KEEPER_ADMIN_TOKEN`, `KEEPER_STORAGE_TOKEN`,
`KEEPER_RUNTIME_CONFIG`, and `KEEPER_PUBLIC_ORIGIN` secrets before deployment.
The public origin must be the Worker's HTTPS origin. Administrative routes are
`/admin/status`, `/admin/import`, `/admin/activate`, `/admin/stop`, and
`/admin/reconcile`; `/rpc` is reserved for the runtime storage credential.

Tests live in `keeper/cloudflare/tests/`. The HTTPS transport test requires
OpenSSL; supervisor tests require Linux, and the runtime shim test runs inside
the built image with a disposable HTTPS fixture. The live keeper remains on
Railway pending quiesced export, upstream repair, and live checks. Frontend
defaults target the Cloudflare Worker; deployed `VITE_GAME_API_URL` and WebSocket
overrides must change only after the keeper handoff is verified.

```bash
bun run dev
bun run dev:local
bun run dev:testnet
bun run dev:mainnet
```

## Tests

```bash
bun run anchor:build
bun run anchor:test
bun run test:e2e:local
```

## Canonical Truth

- runtime and deployment truth comes from
  `packages/hyperbet-chain-registry/src/index.ts`
- local package manifests are not canonical launch truth
- current launch-chain blocker on Solana is the missing canonical
  `goldAmmMarketProgramId` for mainnet
