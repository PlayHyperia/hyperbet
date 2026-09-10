import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import bs58 from "bs58";

import {
  collectFinalizedSignatureBackfill,
  digestFailedFinalizedTransaction,
  digestLifecycleFacts,
  exactFinalizedSignatureSucceeded,
  exactFinalizedTransactionMetaSucceeded,
  hasExactSuccessfulFinalizedTransactionMeta,
  MAX_FINALIZED_SIGNATURE_PAGES,
  MAX_FINALIZED_SIGNATURE_PAGE_SIZE,
  MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE,
  normalizeLifecycleFact,
  requireExactFinalizedTransactionBatch,
  requireExactFinalizedBlockTimeParity,
  resolveClusterLifecycleIndexStartSlot,
  resolveLifecycleIndexStartSlot,
  unitsReleasedByVaultRefund,
  verifyClaimLifecycleAccounting,
  verifyClaimTransferEvidence,
  verifyLosingBalanceCleanupAccounting,
  type SignaturePageEntry,
  type SignaturePageRequest,
  type SolanaLifecycleFact,
} from "./solanaLifecycleIndexer";

function signature(index: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(index, 0);
  bytes.writeUInt32LE((index ^ 0xa5a5a5a5) >>> 0, 4);
  return bs58.encode(bytes);
}

const MARKET = bs58.encode(Buffer.alloc(32, 7));
const WALLET = bs58.encode(Buffer.alloc(32, 9));
const MARKET_MAKER = bs58.encode(Buffer.alloc(32, 10));

function entry(
  index: number,
  slot: number,
  overrides: Partial<SignaturePageEntry> = {},
): SignaturePageEntry {
  return {
    signature: signature(index),
    slot,
    blockTime: 1_700_000_000 + slot,
    err: null,
    confirmationStatus: "finalized",
    ...overrides,
  };
}

function pagedHistory(history: SignaturePageEntry[]) {
  return async ({ before, limit }: SignaturePageRequest) => {
    const start = before
      ? history.findIndex((item) => item.signature === before) + 1
      : 0;
    return history.slice(start, start + limit);
  };
}

describe("finalized Solana lifecycle signature backfill", () => {
  test("requires one ordered finalized transaction response per canonical request", () => {
    const first = { id: "first" };
    const second = { id: "second" };
    expect(
      requireExactFinalizedTransactionBatch({
        requestedSignatures: [signature(1), signature(2)],
        transactions: [first, second],
      }),
    ).toEqual([first, second]);

    for (const input of [
      {
        requestedSignatures: [] as string[],
        transactions: [],
      },
      {
        requestedSignatures: [signature(1), signature(1)],
        transactions: [first, second],
      },
      {
        requestedSignatures: ["not-a-signature"],
        transactions: [first],
      },
      {
        requestedSignatures: [signature(1), signature(2)],
        transactions: [first],
      },
      {
        requestedSignatures: [signature(1)],
        transactions: [first, second],
      },
      {
        requestedSignatures: [signature(1)],
        transactions: { 0: first, length: 1 },
      },
      {
        requestedSignatures: Array.from(
          { length: MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE + 1 },
          (_, index) => signature(index + 10),
        ),
        transactions: Array.from(
          { length: MAX_FINALIZED_TRANSACTION_RPC_BATCH_SIZE + 1 },
          (_, index) => ({ index }),
        ),
      },
      {
        requestedSignatures: new Array(1),
        transactions: [first],
      },
      {
        requestedSignatures: [signature(1)],
        transactions: new Array(1),
      },
    ]) {
      expect(() => requireExactFinalizedTransactionBatch(input)).toThrow(
        "transaction batch",
      );
    }
  });

  test("copies finalized transaction batches from dense data without executing accessors", () => {
    const descriptorTransaction = { id: "descriptor" };
    let rawReads = 0;
    const divergentResponse = new Proxy([descriptorTransaction], {
      get(target, property, receiver) {
        if (property === "0") {
          rawReads += 1;
          return { id: "raw" };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      requireExactFinalizedTransactionBatch({
        requestedSignatures: [signature(1)],
        transactions: divergentResponse,
      }),
    ).toEqual([descriptorTransaction]);
    expect(rawReads).toBe(0);

    let accessorReads = 0;
    const accessorResponse: unknown[] = [];
    Object.defineProperty(accessorResponse, "0", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return descriptorTransaction;
      },
    });
    accessorResponse.length = 1;
    expect(() =>
      requireExactFinalizedTransactionBatch({
        requestedSignatures: [signature(1)],
        transactions: accessorResponse,
      }),
    ).toThrow("transaction batch");
    expect(accessorReads).toBe(0);
  });

  test("classifies finalized success only from exact RPC error states", () => {
    expect(exactFinalizedSignatureSucceeded(null)).toBe(true);
    expect(exactFinalizedSignatureSucceeded("AccountInUse")).toBe(false);
    expect(
      exactFinalizedSignatureSucceeded({
        InstructionError: [0, { Custom: 1 }],
      }),
    ).toBe(false);

    for (const invalid of [
      undefined,
      false,
      true,
      0,
      1,
      "",
      " AccountInUse",
      [],
    ]) {
      expect(() => exactFinalizedSignatureSucceeded(invalid)).toThrow(
        "transaction error",
      );
    }

    expect(hasExactSuccessfulFinalizedTransactionMeta({ err: null })).toBe(
      true,
    );
    expect(exactFinalizedTransactionMetaSucceeded({ err: null })).toBe(true);
    expect(
      exactFinalizedTransactionMetaSucceeded({ err: "AccountInUse" }),
    ).toBe(false);
    for (const rejected of [
      null,
      {},
      { err: undefined },
      { err: false },
      { err: 0 },
      { err: "" },
      { err: "AccountInUse" },
      { err: { InstructionError: [0, "InvalidArgument"] } },
      Object.create({ err: null }) as object,
    ]) {
      expect(hasExactSuccessfulFinalizedTransactionMeta(rejected)).toBe(false);
    }
    expect(() => exactFinalizedTransactionMetaSucceeded({})).toThrow(
      "execution metadata",
    );
    const arrayMeta: unknown[] & { err?: unknown } = [];
    arrayMeta.err = null;
    const dateMeta = Object.assign(new Date(0), { err: null });
    let accessorReads = 0;
    const accessorMeta = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorMeta, "err", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return null;
      },
    });
    for (const invalidMeta of [arrayMeta, dateMeta, accessorMeta]) {
      expect(hasExactSuccessfulFinalizedTransactionMeta(invalidMeta)).toBe(
        false,
      );
      expect(() => exactFinalizedTransactionMetaSucceeded(invalidMeta)).toThrow(
        "execution metadata",
      );
    }
    expect(accessorReads).toBe(0);
    expect(digestFailedFinalizedTransaction(signature(10))).toBe(
      createHash("sha256")
        .update(`failed:${signature(10)}`)
        .digest("hex"),
    );
    expect(() => digestFailedFinalizedTransaction("not-a-signature")).toThrow(
      "signature is invalid",
    );
  });

  test("requires signature-history entries to be plain data without executing accessors", async () => {
    const arrayEntry = [] as unknown as SignaturePageEntry;
    Object.assign(arrayEntry as object, entry(11, 111));
    let accessorReads = 0;
    const accessorEntry = {
      signature: signature(12),
      slot: 112,
      blockTime: 1_700_000_112,
      confirmationStatus: "finalized",
    } as SignaturePageEntry;
    Object.defineProperty(accessorEntry, "err", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return null;
      },
    });
    const dateEntry = Object.assign(new Date(0), entry(13, 113));

    for (const invalidEntry of [
      arrayEntry,
      accessorEntry,
      dateEntry,
      {
        signature: signature(14),
        slot: 114,
        blockTime: 1_700_000_114,
        confirmationStatus: "finalized",
      },
    ]) {
      await expect(
        collectFinalizedSignatureBackfill({
          fetchPage: async () => [invalidEntry],
          checkpointSignature: null,
          checkpointSlot: null,
          startSlot: 100,
          minimumAvailableSlot: 90,
          pageSize: 2,
          maxPages: 1,
        }),
      ).rejects.toThrow("invalid entry metadata");
    }
    expect(accessorReads).toBe(0);
  });

  test("paginates from the normalized signature without rereading provider objects", async () => {
    const normalizedSignature = signature(15);
    const divergentRawSignature = signature(16);
    let rawSignatureReads = 0;
    const rawEntry = new Proxy(entry(15, 115), {
      get(target, property, receiver) {
        if (property === "signature") {
          rawSignatureReads += 1;
          return divergentRawSignature;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const requests: SignaturePageRequest[] = [];
    let calls = 0;
    const result = await collectFinalizedSignatureBackfill({
      fetchPage: async (request) => {
        requests.push(request);
        return calls++ === 0 ? [rawEntry] : [];
      },
      checkpointSignature: null,
      checkpointSlot: null,
      startSlot: 100,
      minimumAvailableSlot: 90,
      pageSize: 2,
      maxPages: 2,
    });

    expect(result.map((item) => item.signature)).toEqual([normalizedSignature]);
    expect(requests[1]?.before).toBe(normalizedSignature);
    expect(rawSignatureReads).toBe(0);
  });

  test("copies signature pages from dense data without executing position accessors", async () => {
    const descriptorEntry = entry(17, 117);
    let rawPageReads = 0;
    const divergentPage = new Proxy([descriptorEntry], {
      get(target, property, receiver) {
        if (property === "0") {
          rawPageReads += 1;
          return entry(18, 118);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let calls = 0;
    const result = await collectFinalizedSignatureBackfill({
      fetchPage: async () => (calls++ === 0 ? divergentPage : []),
      checkpointSignature: null,
      checkpointSlot: null,
      startSlot: 100,
      minimumAvailableSlot: 90,
      pageSize: 2,
      maxPages: 2,
    });
    expect(result.map((item) => item.signature)).toEqual([
      descriptorEntry.signature,
    ]);
    expect(rawPageReads).toBe(0);

    let pagePositionReads = 0;
    const accessorPage: SignaturePageEntry[] = [];
    Object.defineProperty(accessorPage, "0", {
      enumerable: true,
      get() {
        pagePositionReads += 1;
        return descriptorEntry;
      },
    });
    accessorPage.length = 1;
    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: async () => accessorPage,
        checkpointSignature: null,
        checkpointSlot: null,
        startSlot: 100,
        minimumAvailableSlot: 90,
        pageSize: 2,
        maxPages: 1,
      }),
    ).rejects.toThrow("invalid signature page");
    expect(pagePositionReads).toBe(0);
  });

  test("requires exact nullable block-time parity across finalized RPC views", () => {
    expect(
      requireExactFinalizedBlockTimeParity({
        referenceBlockTime: 1_700_000_000,
        transactionBlockTime: 1_700_000_000,
      }),
    ).toBe(1_700_000_000);
    expect(
      requireExactFinalizedBlockTimeParity({
        referenceBlockTime: null,
        transactionBlockTime: null,
      }),
    ).toBeNull();

    for (const [referenceBlockTime, transactionBlockTime] of [
      [1_700_000_000, null],
      [null, 1_700_000_000],
      [1_700_000_000, 1_700_000_001],
      [1_700_000_000, undefined],
      [1_700_000_000, "1700000000"],
      [1_700_000_000, -1],
      [1_700_000_000, 1.5],
      [1_700_000_000, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(() =>
        requireExactFinalizedBlockTimeParity({
          referenceBlockTime,
          transactionBlockTime,
        }),
      ).toThrow("block time");
    }
  });

  test("paginates to a durable checkpoint and returns every new signature oldest-first", async () => {
    const history = [
      entry(9, 109),
      entry(8, 108),
      entry(7, 107, { err: { InstructionError: [0, "Custom"] } }),
      entry(6, 106),
      entry(5, 105),
      entry(4, 104),
    ];

    const result = await collectFinalizedSignatureBackfill({
      fetchPage: pagedHistory(history),
      checkpointSignature: signature(4),
      checkpointSlot: 104,
      startSlot: 100,
      minimumAvailableSlot: 90,
      pageSize: 2,
    });

    expect(result.map((item) => item.signature)).toEqual([
      signature(5),
      signature(6),
      signature(7),
      signature(8),
      signature(9),
    ]);
    expect(
      result.find((item) => item.signature === signature(7))?.succeeded,
    ).toBe(false);
  });

  test("bootstraps exactly at the configured launch slot", async () => {
    const result = await collectFinalizedSignatureBackfill({
      fetchPage: pagedHistory([
        entry(4, 104),
        entry(3, 103),
        entry(2, 102),
        entry(1, 99),
      ]),
      checkpointSignature: null,
      checkpointSlot: null,
      startSlot: 102,
      minimumAvailableSlot: 80,
      pageSize: 2,
    });

    expect(result.map((item) => item.slot)).toEqual([102, 103, 104]);
  });

  test("uses the durable checkpoint instead of the original start slot after ledger pruning", async () => {
    const result = await collectFinalizedSignatureBackfill({
      fetchPage: pagedHistory([entry(4, 104), entry(3, 103)]),
      checkpointSignature: signature(3),
      checkpointSlot: 103,
      startSlot: 10,
      minimumAvailableSlot: 100,
    });
    expect(result.map((item) => item.signature)).toEqual([signature(4)]);
  });

  test("fails closed on retention loss, missing checkpoints, ordering drift, and non-finalized data", async () => {
    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: pagedHistory([]),
        checkpointSignature: null,
        checkpointSlot: null,
        startSlot: 10,
        minimumAvailableSlot: 11,
      }),
    ).rejects.toThrow("unavailable before slot 11");

    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: pagedHistory([entry(3, 103), entry(2, 102)]),
        checkpointSignature: signature(1),
        checkpointSlot: 101,
        startSlot: 100,
        minimumAvailableSlot: 90,
      }),
    ).rejects.toThrow("checkpoint is no longer present");

    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: pagedHistory([entry(2, 102), entry(3, 103)]),
        checkpointSignature: null,
        checkpointSlot: null,
        startSlot: 100,
        minimumAvailableSlot: 90,
      }),
    ).rejects.toThrow("out of newest-first order");

    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: pagedHistory([
          entry(2, 102, { confirmationStatus: "confirmed" }),
        ]),
        checkpointSignature: null,
        checkpointSlot: null,
        startSlot: 100,
        minimumAvailableSlot: 90,
      }),
    ).rejects.toThrow("non-finalized slot");

    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: pagedHistory([entry(2, 102, { confirmationStatus: null })]),
        checkpointSignature: null,
        checkpointSlot: null,
        startSlot: 100,
        minimumAvailableSlot: 90,
      }),
    ).rejects.toThrow("non-finalized slot");

    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: pagedHistory([entry(2, 102, { blockTime: undefined })]),
        checkpointSignature: null,
        checkpointSlot: null,
        startSlot: 100,
        minimumAvailableSlot: 90,
      }),
    ).rejects.toThrow("invalid block time");

    for (const err of [undefined, false] as const) {
      await expect(
        collectFinalizedSignatureBackfill({
          fetchPage: pagedHistory([entry(2, 102, { err })]),
          checkpointSignature: null,
          checkpointSlot: null,
          startSlot: 100,
          minimumAvailableSlot: 90,
        }),
      ).rejects.toThrow("invalid transaction error");
    }
  });

  test("bounds pagination so an RPC cannot force an unbounded poll", async () => {
    let page = 0;
    await expect(
      collectFinalizedSignatureBackfill({
        fetchPage: async () => [entry(10 - page, 110 - page++)],
        checkpointSignature: signature(1),
        checkpointSlot: 101,
        startSlot: 100,
        minimumAvailableSlot: 90,
        pageSize: 1,
        maxPages: 2,
      }),
    ).rejects.toThrow("exceeded 2 page");

    for (const input of [
      {
        pageSize: MAX_FINALIZED_SIGNATURE_PAGE_SIZE + 1,
        maxPages: 1,
      },
      {
        pageSize: 1,
        maxPages: MAX_FINALIZED_SIGNATURE_PAGES + 1,
      },
      {
        pageSize: 1,
        maxPages: Number.MAX_SAFE_INTEGER,
      },
    ]) {
      await expect(
        collectFinalizedSignatureBackfill({
          fetchPage: async () => [],
          checkpointSignature: null,
          checkpointSlot: null,
          startSlot: 0,
          minimumAvailableSlot: 0,
          ...input,
        }),
      ).rejects.toThrow("pagination bounds are invalid");
    }
  });
});

describe("Solana lifecycle index configuration and facts", () => {
  test("parses an explicit exact lifecycle start slot", () => {
    expect(
      resolveLifecycleIndexStartSlot({ value: "123456", required: true }),
    ).toBe(123456);
    expect(
      resolveLifecycleIndexStartSlot({ value: undefined, required: false }),
    ).toBe(0);
    expect(() =>
      resolveLifecycleIndexStartSlot({ value: undefined, required: true }),
    ).toThrow("required for this launch rail");
    expect(() =>
      resolveLifecycleIndexStartSlot({ value: "1.5", required: false }),
    ).toThrow("must be an integer");
    expect(() =>
      resolveLifecycleIndexStartSlot({
        value: String(Number.MAX_SAFE_INTEGER + 1),
        required: false,
      }),
    ).toThrow("safe non-negative integer");
  });

  test("permits an implicit replay boundary only on exact localnet", () => {
    expect(
      resolveClusterLifecycleIndexStartSlot({
        cluster: " localnet ",
        value: undefined,
      }),
    ).toBe(0);
    expect(
      resolveClusterLifecycleIndexStartSlot({
        cluster: "localnet",
        value: "123456",
      }),
    ).toBe(123456);

    for (const cluster of ["devnet", "testnet", "mainnet", "mainnet-beta"]) {
      expect(() =>
        resolveClusterLifecycleIndexStartSlot({
          cluster,
          value: undefined,
        }),
      ).toThrow("required for this launch rail");
      expect(() =>
        resolveClusterLifecycleIndexStartSlot({ cluster, value: "0" }),
      ).toThrow("positive verified deployment slot");
      expect(
        resolveClusterLifecycleIndexStartSlot({ cluster, value: "123456" }),
      ).toBe(123456);
    }
  });

  test("rejects unknown lifecycle-index rails", () => {
    expect(() =>
      resolveClusterLifecycleIndexStartSlot({
        cluster: "solana",
        value: "123456",
      }),
    ).toThrow("Unsupported Solana lifecycle-index cluster");
  });

  test("wires the read-only service through the cluster-aware replay policy", () => {
    const source = readFileSync(
      new URL("./service.ts", import.meta.url),
      "utf8",
    );
    expect(
      source.match(/resolveClusterLifecycleIndexStartSlot\(\{/g),
    ).toHaveLength(1);
    expect(source).not.toContain("required: SERVICE_IS_MAINNET");
  });

  test("normalizes exact lifecycle facts and produces a deterministic digest", () => {
    const facts: SolanaLifecycleFact[] = [
      {
        kind: "ORDER_MATCHED",
        marketPda: MARKET,
        makerOrderId: "7",
        takerOrderId: "9",
        price: 620,
        amountUnits: "40000",
      },
      {
        kind: "CANCELLATION_REFUND",
        marketPda: MARKET,
        wallet: WALLET,
        amountLamports: "9007199254740993",
        feeLamports: "0",
        status: "cancelled",
        winner: "none",
      },
      {
        kind: "LOSING_BALANCE_CLOSED",
        marketPda: MARKET,
        wallet: WALLET,
        side: 2,
        amountUnits: "40000",
        amountLamports: "16000",
        status: "resolved",
        winner: "a",
      },
      {
        kind: "FILLED_ORDER_CLOSED",
        marketPda: MARKET,
        orderId: "7",
        wallet: WALLET,
      },
      {
        kind: "PRICE_LEVEL_CLOSED",
        marketPda: MARKET,
        wallet: WALLET,
        side: 2,
        price: 620,
      },
      {
        kind: "RESOLVED_TRADE_FEES_WITHDRAWN",
        marketPda: MARKET,
        treasury: MARKET,
        marketMaker: WALLET,
        submitter: WALLET,
        treasuryFeeLamports: "6",
        marketMakerFeeLamports: "6",
        status: "resolved",
        winner: "a",
      },
    ];

    expect(normalizeLifecycleFact(facts[0]!)).toEqual(facts[0]);
    expect(digestLifecycleFacts(facts)).toBe(digestLifecycleFacts(facts));
    expect(digestLifecycleFacts(facts)).not.toBe(
      digestLifecycleFacts([...facts].reverse()),
    );
  });

  test("rejects malformed or contradictory facts", () => {
    expect(() =>
      normalizeLifecycleFact({
        kind: "ORDER_MATCHED",
        marketPda: MARKET,
        makerOrderId: "7",
        takerOrderId: "9",
        price: 620,
        amountUnits: "1",
      }),
    ).toThrow("positive multiple of 1000");

    expect(() =>
      normalizeLifecycleFact({
        kind: "CANCELLATION_REFUND",
        marketPda: MARKET,
        wallet: WALLET,
        amountLamports: "1000",
        feeLamports: "1",
        status: "cancelled",
        winner: "none",
      }),
    ).toThrow("fee-free cancellation refund");

    expect(() =>
      normalizeLifecycleFact({
        kind: "MARKET_SYNCED",
        marketPda: MARKET,
        status: "resolved",
        winner: "none",
      }),
    ).toThrow("lifecycle/status invariant");

    expect(() =>
      normalizeLifecycleFact({
        kind: "TAKER_EXECUTION",
        marketPda: MARKET,
        orderId: "7",
        wallet: WALLET,
        side: 1,
        price: 600,
        amountUnits: "0",
        releasedAmountUnits: "0",
        amountLamports: "0",
        feeLamports: "0",
        refundLamports: "0",
        treasuryFeeLamports: "0",
        marketMakerFeeLamports: "0",
        selfTradeTriggered: false,
      }),
    ).toThrow("unit/value invariant");

    expect(() =>
      normalizeLifecycleFact({
        kind: "LOSING_BALANCE_CLOSED",
        marketPda: MARKET,
        wallet: WALLET,
        side: 1,
        amountUnits: "40000",
        amountLamports: "16000",
        status: "resolved",
        winner: "a",
      }),
    ).toThrow("resolved losing value");

    expect(() =>
      normalizeLifecycleFact({
        kind: "RESOLVED_TRADE_FEES_WITHDRAWN",
        marketPda: MARKET,
        treasury: MARKET,
        marketMaker: WALLET,
        submitter: WALLET,
        treasuryFeeLamports: "0",
        marketMakerFeeLamports: "0",
        status: "resolved",
        winner: "a",
      }),
    ).toThrow("positive canonical resolved release");

    expect(() =>
      normalizeLifecycleFact({
        kind: "CANCELLATION_REFUND",
        marketPda: MARKET,
        wallet: WALLET,
        amountLamports: "1000",
        feeLamports: "0",
        treasuryFeeLamports: "600",
        marketMakerFeeLamports: "500",
        status: "cancelled",
        winner: "none",
      }),
    ).toThrow("fee-free cancellation refund");

    expect(() =>
      normalizeLifecycleFact({
        kind: "LOSING_BALANCE_CLOSED",
        marketPda: MARKET,
        wallet: WALLET,
        side: 2,
        amountUnits: "0",
        amountLamports: "0",
        status: "resolved",
        winner: "a",
      }),
    ).toThrow("resolved losing value");

    expect(() =>
      normalizeLifecycleFact({
        kind: "FILLED_ORDER_CLOSED",
        marketPda: MARKET,
        orderId: "7",
        wallet: WALLET,
        amountLamports: "1",
      }),
    ).toThrow("invalid amountLamports");

    expect(() =>
      normalizeLifecycleFact({
        kind: "PRICE_LEVEL_CLOSED",
        marketPda: MARKET,
        wallet: WALLET,
        side: 2,
        price: 620,
        amountLamports: "1",
      }),
    ).toThrow("invalid amountLamports");
  });

  test("rejects zero order identities in every lifecycle position", () => {
    expect(() =>
      normalizeLifecycleFact({
        kind: "ORDER_PLACED",
        marketPda: MARKET,
        orderId: "0",
        wallet: WALLET,
        side: 1,
        price: 600,
        orderBehavior: 0,
        amountUnits: "1000",
      }),
    ).toThrow("positive integer");

    for (const invalid of [
      { makerOrderId: "0", takerOrderId: "9" },
      { makerOrderId: "7", takerOrderId: "0" },
    ]) {
      expect(() =>
        normalizeLifecycleFact({
          kind: "ORDER_MATCHED",
          marketPda: MARKET,
          ...invalid,
          price: 620,
          amountUnits: "1000",
        }),
      ).toThrow("positive integer");
    }
  });

  test("rejects lifecycle integers outside the on-chain u64 domain", () => {
    const u64Max = ((1n << 64n) - 1n).toString();
    const u64Overflow = (1n << 64n).toString();
    expect(
      normalizeLifecycleFact({
        kind: "FILLED_ORDER_CLOSED",
        marketPda: MARKET,
        orderId: u64Max,
        wallet: WALLET,
      }),
    ).toMatchObject({ orderId: u64Max });
    expect(() =>
      normalizeLifecycleFact({
        kind: "FILLED_ORDER_CLOSED",
        marketPda: MARKET,
        orderId: u64Overflow,
        wallet: WALLET,
      }),
    ).toThrow("u64 domain");
    expect(() =>
      normalizeLifecycleFact({
        kind: "CANCELLATION_REFUND",
        marketPda: MARKET,
        wallet: WALLET,
        amountLamports: u64Overflow,
        feeLamports: "0",
        status: "cancelled",
        winner: "none",
      }),
    ).toThrow("u64 domain");
  });

  test("derives exact cancel/reclaim units and rejects rounded refunds", () => {
    expect(
      unitsReleasedByVaultRefund({ side: 1, price: 600, lamports: 24000n }),
    ).toBe(40000n);
    expect(
      unitsReleasedByVaultRefund({ side: 2, price: 600, lamports: 16000n }),
    ).toBe(40000n);
    expect(() =>
      unitsReleasedByVaultRefund({ side: 1, price: 600, lamports: 1n }),
    ).toThrow("exact units");
  });

  test("classifies fee-free refunds and verifies winnings-fee conservation", () => {
    expect(
      verifyClaimLifecycleAccounting({
        status: "cancelled",
        winner: "none",
        payoutLamports: 60_000n,
        feeLamports: 0n,
        winningsFeeBps: 200,
      }),
    ).toBe("CANCELLATION_REFUND");
    expect(
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "a",
        payoutLamports: 98_000n,
        feeLamports: 2_000n,
        winningsFeeBps: 200,
      }),
    ).toBe("CLAIM_PAYOUT");
    expect(
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "b",
        payoutLamports: 0n,
        feeLamports: 100_000n,
        winningsFeeBps: 10_000,
      }),
    ).toBe("CLAIM_PAYOUT");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "b",
        payoutLamports: 98_001n,
        feeLamports: 1_999n,
        winningsFeeBps: 200,
      }),
    ).toThrow("fee snapshot");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "cancelled",
        winner: "none",
        payoutLamports: 100_000n,
        feeLamports: 1n,
        winningsFeeBps: 200,
      }),
    ).toThrow("fee-free refunds");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "resolved",
        winner: "a",
        payoutLamports: 0n,
        feeLamports: 0n,
        winningsFeeBps: 10_000,
      }),
    ).toThrow("no gross entitlement");
    expect(() =>
      verifyClaimLifecycleAccounting({
        status: "cancelled",
        winner: "none",
        payoutLamports: 0n,
        feeLamports: 0n,
        winningsFeeBps: 0,
      }),
    ).toThrow("fee-free refunds");
  });

  test("accepts exact zero-payout resolved claim evidence at the program fee boundary", () => {
    expect(
      verifyClaimTransferEvidence({
        transfers: [
          {
            source: MARKET,
            destination: MARKET_MAKER,
            lamports: 100_000n,
          },
        ],
        vault: MARKET,
        wallet: WALLET,
        marketMaker: MARKET_MAKER,
        eventPayoutLamports: 0n,
        eventWinningsFeeLamports: 100_000n,
      }),
    ).toEqual({ payoutLamports: 0n, feeLamports: 100_000n });

    expect(
      normalizeLifecycleFact({
        kind: "CLAIM_PAYOUT",
        marketPda: MARKET,
        wallet: WALLET,
        amountLamports: "0",
        feeLamports: "100000",
        status: "resolved",
        winner: "b",
      }),
    ).toMatchObject({ amountLamports: "0", feeLamports: "100000" });
  });

  test("conserves aliased and distinct zero-payout claim transfers", () => {
    expect(
      verifyClaimTransferEvidence({
        transfers: [
          { source: MARKET, destination: WALLET, lamports: 100_000n },
        ],
        vault: MARKET,
        wallet: WALLET,
        marketMaker: WALLET,
        eventPayoutLamports: 0n,
        eventWinningsFeeLamports: 100_000n,
      }),
    ).toEqual({ payoutLamports: 0n, feeLamports: 100_000n });

    expect(() =>
      verifyClaimTransferEvidence({
        transfers: [],
        vault: MARKET,
        wallet: WALLET,
        marketMaker: MARKET_MAKER,
        eventPayoutLamports: 0n,
        eventWinningsFeeLamports: 100_000n,
      }),
    ).toThrow("claim transfers do not match");
    expect(() =>
      verifyClaimTransferEvidence({
        transfers: [],
        vault: MARKET,
        wallet: WALLET,
        marketMaker: MARKET_MAKER,
        eventPayoutLamports: 0n,
        eventWinningsFeeLamports: 0n,
      }),
    ).toThrow("noncanonical");
  });

  test("classifies only exact loser-side cleanup accounting", () => {
    expect(
      verifyLosingBalanceCleanupAccounting({
        status: "resolved",
        winner: "a",
        aShares: 0n,
        bShares: 40_000n,
        aLockedLamports: 0n,
        bLockedLamports: 16_000n,
      }),
    ).toEqual({ side: 2, amountUnits: 40_000n, amountLamports: 16_000n });

    expect(
      verifyLosingBalanceCleanupAccounting({
        status: "resolved",
        winner: "b",
        aShares: 40_000n,
        bShares: 0n,
        aLockedLamports: 24_000n,
        bLockedLamports: 0n,
      }),
    ).toEqual({ side: 1, amountUnits: 40_000n, amountLamports: 24_000n });

    expect(() =>
      verifyLosingBalanceCleanupAccounting({
        status: "resolved",
        winner: "a",
        aShares: 1_000n,
        bShares: 40_000n,
        aLockedLamports: 600n,
        bLockedLamports: 16_000n,
      }),
    ).toThrow("only nonempty resolved losing value");
    expect(() =>
      verifyLosingBalanceCleanupAccounting({
        status: "cancelled",
        winner: "none",
        aShares: 0n,
        bShares: 40_000n,
        aLockedLamports: 0n,
        bLockedLamports: 16_000n,
      }),
    ).toThrow("only nonempty resolved losing value");
    expect(() =>
      verifyLosingBalanceCleanupAccounting({
        status: "resolved",
        winner: "a",
        aShares: 0n,
        bShares: 1n,
        aLockedLamports: 0n,
        bLockedLamports: 1n,
      }),
    ).toThrow("lot size");
  });
});
