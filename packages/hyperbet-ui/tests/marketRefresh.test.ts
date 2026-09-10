import "./setup";
import { describe, expect, it } from "bun:test";
import bs58 from "bs58";

import {
  HYPERBET_MARKET_REFRESH_EVENT,
  parseHyperbetConfirmedSettlementRefresh,
} from "../src/lib/marketRefresh";

const key = (seed: number) => bs58.encode(new Uint8Array(32).fill(seed));
const signature = (seed: number) => bs58.encode(new Uint8Array(64).fill(seed));

function refreshEvent(detail: unknown): Event {
  return new CustomEvent(HYPERBET_MARKET_REFRESH_EVENT, { detail });
}

describe("Hyperbet confirmed settlement refresh", () => {
  it("accepts only the exact canonical Solana confirmation envelope", () => {
    expect(
      parseHyperbetConfirmedSettlementRefresh(
        refreshEvent({
          schemaVersion: 1,
          mutation: "SETTLEMENT_CONFIRMED",
          wallet: key(1),
          marketPda: key(2),
          signature: signature(3),
          kind: "CLEANUP",
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      mutation: "SETTLEMENT_CONFIRMED",
      wallet: key(1),
      marketPda: key(2),
      signature: signature(3),
      kind: "CLEANUP",
    });
  });

  it("rejects malformed identities, signatures, and extra authority fields", () => {
    const valid = {
      schemaVersion: 1,
      mutation: "SETTLEMENT_CONFIRMED",
      wallet: key(1),
      marketPda: key(2),
      signature: signature(3),
      kind: "CLAIM",
    } as const;
    for (const detail of [
      { ...valid, wallet: `${valid.wallet} ` },
      { ...valid, wallet: "not-a-solana-key" },
      { ...valid, marketPda: key(2).slice(1) },
      { ...valid, signature: key(3) },
      { ...valid, signature: `${valid.signature} ` },
      { ...valid, kind: "RENT" },
      { ...valid, schemaVersion: 2 },
      { ...valid, mutation: "SETTLEMENT_PENDING" },
      { ...valid, amountLamports: "1" },
    ]) {
      expect(
        parseHyperbetConfirmedSettlementRefresh(refreshEvent(detail)),
      ).toBeNull();
    }
  });
});
