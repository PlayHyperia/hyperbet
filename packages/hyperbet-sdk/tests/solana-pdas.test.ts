import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  duelKeyHexToBytes,
  findDuelStatePda,
  findMarketStatePda,
} from "../src/solana/client";
import { MARKET_KIND_DUEL_WINNER } from "../src/types";

describe("canonical SOL duel PDAs", () => {
  it("uses the on-chain duel-winner market kind and exact launch seeds", () => {
    expect(MARKET_KIND_DUEL_WINNER).toBe(1);
    const oracle = new PublicKey(
      "FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu",
    );
    const marketProgram = new PublicKey(
      "7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG",
    );
    const duelKey = duelKeyHexToBytes(
      "1f1e1d1c1b1a19181716151413121110f1e2d3c4b5a697887766554433221100",
    );
    const duel = findDuelStatePda(oracle, duelKey);
    expect(duel.toBase58()).toBe("g1qh9B6wiBujNncuDRHJuKQcRmsAYUYRdpcp3VNXKh6");
    expect(findMarketStatePda(marketProgram, duel).toBase58()).toBe(
      "GQfzUQRCDWdiUgP2bCdkhDpdGGp9hhD1ERab6PTX7HAp",
    );
  });
});
