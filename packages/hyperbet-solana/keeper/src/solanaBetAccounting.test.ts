import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import bs58 from "bs58";

import {
  classifySignatureFinality,
  decodePlaceOrderInstructionData,
  exactPrimarySolanaTransactionSignature,
  exactSolanaTransactionSignatures,
  hasOnlyAllowedNativeTransferEdges,
  isCanonicalSolanaTransactionSignature,
  requiresFinalizedBetVerification,
  verifyIndexedPlaceOrderAccounting,
  verifyPlaceOrderAccounting,
  type DecodedPlaceOrder,
  type NativeTransferEvidence,
} from "./solanaBetAccounting";

const wallet = "wallet";
const marketRef = "market";
const vault = "vault";
const treasury = "treasury";
const marketMaker = "market-maker";

function encodeOrder(order: DecodedPlaceOrder): string {
  const raw = Buffer.alloc(28);
  createHash("sha256")
    .update("global:place_order")
    .digest()
    .subarray(0, 8)
    .copy(raw, 0);
  raw.writeBigUInt64LE(order.orderId, 8);
  raw.writeUInt8(order.side, 16);
  raw.writeUInt16LE(order.price, 17);
  raw.writeBigUInt64LE(order.amount, 19);
  raw.writeUInt8(order.orderBehavior, 27);
  return bs58.encode(raw);
}

function order(overrides: Partial<DecodedPlaceOrder> = {}): DecodedPlaceOrder {
  return {
    orderId: 7n,
    side: 1,
    price: 600,
    amount: 100_000n,
    orderBehavior: 0,
    ...overrides,
  };
}

function transfers(
  entries: Array<[string, string, bigint]>,
): NativeTransferEvidence[] {
  return entries.map(([source, destination, lamports]) => ({
    source,
    destination,
    lamports,
  }));
}

function verify(overrides: Record<string, unknown> = {}) {
  const signedOrder =
    (overrides.order as DecodedPlaceOrder | undefined) ?? order();
  return verifyPlaceOrderAccounting({
    order: signedOrder,
    wallet,
    marketRef,
    vault,
    treasury,
    marketMaker,
    tradeTreasuryFeeBps: 100,
    tradeMarketMakerFeeBps: 100,
    placedEvents: [
      {
        marketRef,
        orderId: signedOrder.orderId,
        maker: wallet,
        side: signedOrder.side,
        price: signedOrder.price,
        amount: signedOrder.amount,
      },
    ],
    matchedEvents: [],
    selfTradeEvents: [],
    tradeFeeEscrowEvents: [],
    transfers: [],
    ...overrides,
  });
}

describe("Solana place-order decoding", () => {
  test("decodes the exact audited instruction layout", () => {
    const signedOrder = order({ orderBehavior: 2 });
    expect(decodePlaceOrderInstructionData(encodeOrder(signedOrder))).toEqual(
      signedOrder,
    );
  });

  test("rejects malformed, trailing, and invalid order data", () => {
    expect(decodePlaceOrderInstructionData("bad")).toBeNull();
    const valid = Buffer.from(bs58.decode(encodeOrder(order())));
    expect(
      decodePlaceOrderInstructionData(
        bs58.encode(Buffer.concat([valid, valid])),
      ),
    ).toBeNull();
    expect(
      decodePlaceOrderInstructionData(encodeOrder(order({ amount: 999n }))),
    ).toBeNull();
  });
});

describe("native SOL instruction transfer edges", () => {
  test("admits only positive transfers on an explicitly allowed edge", () => {
    const allowedEdges = [{ source: vault, destination: wallet }];
    expect(
      hasOnlyAllowedNativeTransferEdges(
        transfers([[vault, wallet, 1n]]),
        allowedEdges,
      ),
    ).toBe(true);
    expect(
      hasOnlyAllowedNativeTransferEdges(
        transfers([["attacker", wallet, 1n]]),
        allowedEdges,
      ),
    ).toBe(false);
    expect(
      hasOnlyAllowedNativeTransferEdges(
        transfers([[wallet, vault, 1n]]),
        allowedEdges,
      ),
    ).toBe(false);
    expect(
      hasOnlyAllowedNativeTransferEdges(
        transfers([[vault, wallet, 0n]]),
        allowedEdges,
      ),
    ).toBe(false);
  });
});

describe("recorded-bet verification policy", () => {
  test("accepts only canonical 64-byte Solana transaction signatures", () => {
    const signature = bs58.encode(Buffer.alloc(64, 7));
    expect(isCanonicalSolanaTransactionSignature(signature)).toBe(true);
    expect(isCanonicalSolanaTransactionSignature(` ${signature}`)).toBe(false);
    expect(
      isCanonicalSolanaTransactionSignature(bs58.encode(Buffer.alloc(63))),
    ).toBe(false);
    expect(isCanonicalSolanaTransactionSignature("not-base58-0OIl")).toBe(
      false,
    );
  });

  test("binds finalized transaction identity to the first canonical signature", () => {
    const primary = bs58.encode(Buffer.alloc(64, 7));
    const secondary = bs58.encode(Buffer.alloc(64, 8));
    expect(exactPrimarySolanaTransactionSignature([primary, secondary])).toBe(
      primary,
    );
    expect(exactPrimarySolanaTransactionSignature([secondary, primary])).toBe(
      secondary,
    );
    expect(exactSolanaTransactionSignatures([primary, secondary])).toEqual([
      primary,
      secondary,
    ]);
    expect(exactPrimarySolanaTransactionSignature([])).toBeNull();
    expect(exactPrimarySolanaTransactionSignature(null)).toBeNull();
    expect(
      exactPrimarySolanaTransactionSignature([primary, ` ${secondary}`]),
    ).toBeNull();
    expect(
      exactPrimarySolanaTransactionSignature(
        new Proxy([primary], {
          get: () => {
            throw new Error("hostile signature list");
          },
        }),
      ),
    ).toBeNull();
  });

  test("distinguishes finalized, pending, and failed signatures", () => {
    expect(classifySignatureFinality(null)).toBe("pending");
    expect(
      classifySignatureFinality({ err: null, confirmationStatus: "confirmed" }),
    ).toBe("pending");
    expect(
      classifySignatureFinality({ err: null, confirmationStatus: "finalized" }),
    ).toBe("finalized");
    expect(
      classifySignatureFinality({
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "finalized",
      }),
    ).toBe("rejected");
  });

  test("never permits the development write-key bypass on production or mainnet", () => {
    expect(
      requiresFinalizedBetVerification({
        nodeEnv: "development",
        cluster: "mainnet-beta",
      }),
    ).toBe(true);
    expect(
      requiresFinalizedBetVerification({
        nodeEnv: "production",
        cluster: "localnet",
      }),
    ).toBe(true);
    expect(
      requiresFinalizedBetVerification({
        nodeEnv: "development",
        cluster: "localnet",
      }),
    ).toBe(false);
    expect(
      requiresFinalizedBetVerification({
        nodeEnv: undefined,
        cluster: undefined,
      }),
    ).toBe(true);
  });
});

describe("authoritative Solana bet accounting", () => {
  test("records resting collateral but awards no volume points before a fill", () => {
    expect(
      verify({
        transfers: transfers([[wallet, vault, 60_000n]]),
      }),
    ).toMatchObject({
      matchedAmountUnits: "0",
      restingAmountUnits: "100000",
      releasedAmountUnits: "0",
      collateralLamports: "60000",
      executedCostLamports: "0",
      feeAmountLamports: "0",
      sourceAmountLamports: "60000",
      rewardEligibleLamports: "0",
    });
  });

  test("uses actual match prices, exact improvement refunds, and split fee floors", () => {
    expect(
      verify({
        matchedEvents: [
          {
            marketRef,
            takerOrderId: 7n,
            matchedAmount: 40_000n,
            price: 500,
          },
        ],
        transfers: transfers([
          [wallet, vault, 60_000n],
          [wallet, vault, 400n],
          [vault, wallet, 4_000n],
        ]),
        tradeFeeEscrowEvents: [
          {
            marketRef,
            orderId: 7n,
            payer: wallet,
            executedCostLamports: 20_000n,
            treasuryFeeLamports: 200n,
            marketMakerFeeLamports: 200n,
          },
        ],
      }),
    ).toMatchObject({
      matchedAmountUnits: "40000",
      restingAmountUnits: "60000",
      releasedAmountUnits: "0",
      collateralLamports: "56000",
      executedCostLamports: "20000",
      tradeTreasuryFeeLamports: "200",
      tradeMarketMakerFeeLamports: "200",
      sourceAmountLamports: "56400",
      rewardEligibleLamports: "20400",
    });
  });

  test("accounts for IOC refunds without treating released units as resting", () => {
    const ioc = order({ orderBehavior: 1 });
    expect(
      verify({
        order: ioc,
        matchedEvents: [
          {
            marketRef,
            takerOrderId: ioc.orderId,
            matchedAmount: 40_000n,
            price: 500,
          },
        ],
        transfers: transfers([
          [wallet, vault, 60_000n],
          [wallet, vault, 400n],
          [vault, wallet, 40_000n],
        ]),
        tradeFeeEscrowEvents: [
          {
            marketRef,
            orderId: ioc.orderId,
            payer: wallet,
            executedCostLamports: 20_000n,
            treasuryFeeLamports: 200n,
            marketMakerFeeLamports: 200n,
          },
        ],
      }),
    ).toMatchObject({
      matchedAmountUnits: "40000",
      restingAmountUnits: "0",
      releasedAmountUnits: "60000",
      collateralLamports: "20000",
    });
  });

  test("requires self-trade evidence when a GTC remainder is released", () => {
    const evidence = {
      matchedEvents: [
        {
          marketRef,
          takerOrderId: 7n,
          matchedAmount: 40_000n,
          price: 500,
        },
      ],
      transfers: transfers([
        [wallet, vault, 60_000n],
        [wallet, vault, 400n],
        [vault, wallet, 40_000n],
      ]),
      tradeFeeEscrowEvents: [
        {
          marketRef,
          orderId: 7n,
          payer: wallet,
          executedCostLamports: 20_000n,
          treasuryFeeLamports: 200n,
          marketMakerFeeLamports: 200n,
        },
      ],
    };
    expect(() => verify(evidence)).toThrow("without self-trade evidence");
    expect(
      verify({
        ...evidence,
        selfTradeEvents: [{ marketRef, takerOrderId: 7n }],
      }),
    ).toMatchObject({
      restingAmountUnits: "0",
      releasedAmountUnits: "60000",
    });
  });

  test("matches the program's separate fee rounding instead of combined bps", () => {
    const tiny = order({ price: 50, amount: 1_000n });
    expect(
      verify({
        order: tiny,
        matchedEvents: [
          {
            marketRef,
            takerOrderId: tiny.orderId,
            matchedAmount: tiny.amount,
            price: tiny.price,
          },
        ],
        transfers: transfers([[wallet, vault, 50n]]),
        tradeFeeEscrowEvents: [
          {
            marketRef,
            orderId: tiny.orderId,
            payer: wallet,
            executedCostLamports: 50n,
            treasuryFeeLamports: 0n,
            marketMakerFeeLamports: 0n,
          },
        ],
      }),
    ).toMatchObject({
      executedCostLamports: "50",
      tradeTreasuryFeeLamports: "0",
      tradeMarketMakerFeeLamports: "0",
      feeAmountLamports: "0",
      sourceAmountLamports: "50",
    });
  });

  test("fails closed on event identity, fee-escrow, and unexplained-transfer drift", () => {
    expect(() =>
      verify({
        placedEvents: [],
        transfers: transfers([[wallet, vault, 60_000n]]),
      }),
    ).toThrow("exactly one order-placed event");
    expect(() =>
      verify({
        matchedEvents: [
          {
            marketRef,
            takerOrderId: 7n,
            matchedAmount: 100_000n,
            price: 600,
          },
        ],
        transfers: transfers([[wallet, vault, 60_000n]]),
      }),
    ).toThrow("fee escrow event");
    expect(() =>
      verify({
        transfers: transfers([
          [wallet, vault, 60_000n],
          [wallet, treasury, 1n],
        ]),
      }),
    ).toThrow("unexplained native transfer");
    expect(() =>
      verify({
        transfers: transfers([
          [wallet, vault, 60_000n],
          [wallet, "unknown", 1n],
        ]),
      }),
    ).toThrow("unexplained native transfer");
    expect(() =>
      verify({
        transfers: transfers([
          [wallet, vault, 60_000n],
          ["attacker", wallet, 1n],
        ]),
      }),
    ).toThrow("unexplained native transfer");
  });
});

describe("durable finalized-index bet accounting", () => {
  const indexedEvidence = {
    orderId: "4",
    side: 1 as const,
    limitPrice: 500,
    orderBehavior: 0 as const,
    orderAmountUnits: "50000000",
    matchedAmountUnits: "50000000",
    releasedAmountUnits: "0",
    executedCostLamports: "25000000",
    refundLamports: "0",
    tradeTreasuryFeeLamports: "250000",
    tradeMarketMakerFeeLamports: "250000",
    selfTradeTriggered: false,
    tradeTreasuryFeeBps: 100,
    tradeMarketMakerFeeBps: 100,
  };

  test("reconstructs the exact verified browser order from durable facts", () => {
    expect(verifyIndexedPlaceOrderAccounting(indexedEvidence)).toEqual({
      orderId: "4",
      side: 1,
      limitPrice: 500,
      orderBehavior: 0,
      orderAmountUnits: "50000000",
      matchedAmountUnits: "50000000",
      restingAmountUnits: "0",
      releasedAmountUnits: "0",
      collateralLamports: "25000000",
      executedCostLamports: "25000000",
      tradeTreasuryFeeLamports: "250000",
      tradeMarketMakerFeeLamports: "250000",
      feeAmountLamports: "500000",
      sourceAmountLamports: "25500000",
      rewardEligibleLamports: "25500000",
    });
  });

  test("reconstructs a fully resting order without inventing rewards", () => {
    expect(
      verifyIndexedPlaceOrderAccounting({
        ...indexedEvidence,
        matchedAmountUnits: "0",
        executedCostLamports: "0",
        tradeTreasuryFeeLamports: "0",
        tradeMarketMakerFeeLamports: "0",
      }),
    ).toMatchObject({
      restingAmountUnits: "50000000",
      collateralLamports: "25000000",
      feeAmountLamports: "0",
      sourceAmountLamports: "25000000",
      rewardEligibleLamports: "0",
    });
  });

  test("rejects indexed unit, collateral, fee, and behavior drift", () => {
    expect(() =>
      verifyIndexedPlaceOrderAccounting({
        ...indexedEvidence,
        matchedAmountUnits: "50001000",
      }),
    ).toThrow("unit conservation");
    expect(() =>
      verifyIndexedPlaceOrderAccounting({
        ...indexedEvidence,
        refundLamports: "1",
      }),
    ).toThrow("collateral conservation");
    expect(() =>
      verifyIndexedPlaceOrderAccounting({
        ...indexedEvidence,
        tradeTreasuryFeeLamports: "249999",
      }),
    ).toThrow("fee split");
    expect(() =>
      verifyIndexedPlaceOrderAccounting({
        ...indexedEvidence,
        matchedAmountUnits: "49999000",
        releasedAmountUnits: "1000",
      }),
    ).toThrow("order behavior");
  });
});
