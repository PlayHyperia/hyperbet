import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

import {
  keeperRuntimeIdentityMatches,
  parseKeeperRuntimeIdentity,
  resolveKeeperRuntimeIdentity,
} from "./runtimeIdentity";

const FIGHT = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const MARKET = Keypair.fromSeed(
  new Uint8Array(32).fill(2),
).publicKey.toBase58();

describe("keeper runtime identity", () => {
  test("normalizes one exact protected service identity", () => {
    const identity = resolveKeeperRuntimeIdentity({
      role: "service",
      cluster: "devnet",
      fightOracleProgramId: FIGHT,
      duelMarketProgramId: MARKET,
    });
    expect(identity).toEqual({
      schemaVersion: 1,
      role: "service",
      cluster: "devnet",
      fightOracleProgramId: FIGHT,
      duelMarketProgramId: MARKET,
    });
    expect(parseKeeperRuntimeIdentity(identity)).toEqual(identity);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  test("rejects malformed, unsupported, duplicate, and extended identities", () => {
    const base = {
      schemaVersion: 1,
      role: "duel-bot",
      cluster: "mainnet-beta",
      fightOracleProgramId: FIGHT,
      duelMarketProgramId: MARKET,
    };
    expect(parseKeeperRuntimeIdentity({ ...base, debug: true })).toBeNull();
    expect(
      parseKeeperRuntimeIdentity({ ...base, schemaVersion: 2 }),
    ).toBeNull();
    expect(parseKeeperRuntimeIdentity({ ...base, role: "worker" })).toBeNull();
    expect(
      parseKeeperRuntimeIdentity({ ...base, cluster: "unknown" }),
    ).toBeNull();
    expect(
      parseKeeperRuntimeIdentity({
        ...base,
        duelMarketProgramId: FIGHT,
      }),
    ).toBeNull();
    expect(
      parseKeeperRuntimeIdentity({
        ...base,
        fightOracleProgramId: ` ${FIGHT}`,
      }),
    ).toBeNull();
  });

  test("matches every runtime field and the intended role", () => {
    const service = resolveKeeperRuntimeIdentity({
      role: "service",
      cluster: "devnet",
      fightOracleProgramId: FIGHT,
      duelMarketProgramId: MARKET,
    });
    const duelBot = resolveKeeperRuntimeIdentity({
      ...service,
      role: "duel-bot",
    });
    expect(keeperRuntimeIdentityMatches(service, service)).toBe(true);
    expect(keeperRuntimeIdentityMatches(duelBot, service)).toBe(false);
    expect(keeperRuntimeIdentityMatches(null, service)).toBe(false);
  });
});
