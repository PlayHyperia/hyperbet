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

`keeper/cloudflare/runtime-manifest.json` pins the 24 files verified against the
running keeper, including its deployed contract registry. From the repository
root, run `node packages/hyperbet-solana/keeper/cloudflare/prepare-runtime.mjs`
to assemble them in the ignored `.runtime` directory. Fetch the manifest's Git
commits first if the checkout is shallow. The command verifies every file hash
and refuses to overwrite an existing output directory; an optional argument
selects a fresh output path. This prepares source only. Cloudflare activation
still requires durable storage, a quiesced database transfer, and live checks.

`keeper/cloudflare/storage-transport.mjs` provides synchronous HTTPS calls for
the pinned runtime. A missing or invalid response permanently stops that client
from issuing further calls; writes are never retried automatically. Run
`bun packages/hyperbet-solana/keeper/cloudflare/tests/storage-transport.test.mjs`
from the repository root to test against a disposable HTTPS server (requires
OpenSSL). The transport is not connected to the live keeper yet.

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
