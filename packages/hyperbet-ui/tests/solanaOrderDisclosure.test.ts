import { describe, expect, test } from "bun:test";

import { getSolanaCancellationRefundDisclosure } from "../src/lib/solanaOrderDisclosure";

describe("Solana cancellation and refund disclosure", () => {
  test("distinguishes duel cancellation from resting-order cancellation in English", () => {
    const disclosure = getSolanaCancellationRefundDisclosure("en");

    expect(disclosure).toContain(
      "matched collateral and escrowed execution fees are refundable",
    );
    expect(disclosure).toContain("returns unmatched collateral");
    expect(disclosure).toContain("shared PriceLevel rent is excluded");
  });

  test("keeps the Chinese financial disclosure consistent with the program refund path", () => {
    const disclosure = getSolanaCancellationRefundDisclosure("zh");

    expect(disclosure).toContain("托管的成交手续费可通过领取退回");
    expect(disclosure).toContain("未成交抵押");
    expect(disclosure).not.toContain("已收取的成交手续费不会退回");
  });
});
