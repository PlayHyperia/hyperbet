import "./setup";
import { act, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it } from "bun:test";
import bs58 from "bs58";

import { SolanaSettlementHistory as ProductionSolanaSettlementHistory } from "../src/components/SolanaSettlementHistory";
import { buildDuelCorrelationId } from "../src/lib/duelCorrelation";
import { dispatchHyperbetMarketRefresh } from "../src/lib/marketRefresh";
import { cleanupRenderedTrees, render } from "./render";

const originalFetch = globalThis.fetch;
const key = (seed: number) => bs58.encode(new Uint8Array(32).fill(seed));
const signature = (seed: number) => bs58.encode(new Uint8Array(64).fill(seed));
const WALLET = key(1);
const OTHER_WALLET = key(2);
const MARKET = key(3);
const PROGRAM_ID = key(8);
const PLACE_SIGNATURE = signature(5);
const CLAIM_SIGNATURE = signature(6);
const WINNER_CLAIM_SIGNATURE = signature(7);
const LOSER_CLEANUP_SIGNATURE = signature(10);
const RESPONSE_TIME = Date.now();

function historyPayload(current = true) {
  return {
    schemaVersion: 2,
    chain: "SOLANA",
    asset: "SOL",
    decimals: 9,
    cluster: "devnet",
    programId: PROGRAM_ID,
    wallet: WALLET,
    ledger: {
      current,
      lastIndexedAt: RESPONSE_TIME - 100,
      degradedReason: current ? null : "indexer is catching up",
    },
    entries: [
      {
        betId: "bet-1",
        wallet: WALLET,
        marketPda: MARKET,
        duelKey: "ab".repeat(32),
        duelId: "duel-1",
        correlationId:
          "44f5499b0945eb31d924975ecfffcc56e95317e157e9bfb1a1883e429984f087",
        placeSignature: PLACE_SIGNATURE,
        recordedAt: 1_700_000_000_000,
        orderId: "7",
        side: 1,
        limitPrice: 600,
        orderAmountUnits: "1000000000",
        matchedAmountUnits: "1000000000",
        restingAmountUnits: "0",
        releasedAmountUnits: "0",
        sourceAmountLamports: "620000000",
        collateralLamports: "600000000",
        executedCostLamports: "600000000",
        tradeFeeLamports: "20000000",
        orderRefundLamports: "0",
        rewardEligibleLamports: "620000000",
        marketStatus: "resolved",
        winner: "a",
        orderState: "FILLED",
        settlementState: "PAYOUT_CLAIMABLE",
        terminalKind: null,
        terminalStatus: null,
        terminalWinner: null,
        claimSignature: null,
        terminalGrossLamports: "0",
        terminalPayoutLamports: "0",
        terminalFeeLamports: "0",
        reconciledAt: 1_700_000_000_100,
        settledAt: null,
      },
    ],
    total: 1,
    limit: 4,
    offset: 0,
    updatedAt: RESPONSE_TIME,
  };
}

function SolanaSettlementHistory(
  props: Omit<
    ComponentProps<typeof ProductionSolanaSettlementHistory>,
    "programId"
  >,
) {
  return (
    <ProductionSolanaSettlementHistory programId={PROGRAM_ID} {...props} />
  );
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanupRenderedTrees();
  globalThis.fetch = originalFetch;
});

describe("Solana settlement history UI", () => {
  it("shows verified exact settlement amounts for the active duel", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return Response.json(historyPayload());
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        marketPda={MARKET}
        agent1Name="Nova"
        agent2Name="Rook"
      />,
    );
    await flushEffects();

    expect(requestedUrl).toContain(`/api/arena/settlements/${WALLET}`);
    expect(requestedUrl).toContain(`marketPda=${MARKET}`);
    expect(container.textContent).toContain("Verified");
    expect(container.textContent).toContain("YES · Nova");
    expect(container.textContent).toContain("Winnings ready to claim");
    expect(container.textContent).toContain("1 SOL");
    expect(container.textContent).toContain("0.02 SOL");
    expect(container.textContent).toContain("Support ref · 44f5499b0945");
    expect(
      container
        .querySelector('[data-testid="solana-settlement-identity-bet-1"]')
        ?.getAttribute("title"),
    ).toBe("duel-1");
    expect(
      container
        .querySelector('[data-testid="solana-settlement-correlation-bet-1"]')
        ?.getAttribute("title"),
    ).toBe("44f5499b0945eb31d924975ecfffcc56e95317e157e9bfb1a1883e429984f087");
    expect(
      container.querySelectorAll('[data-testid="solana-settlement-entry"]'),
    ).toHaveLength(1);
    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    expect(refreshButton).not.toBeNull();
    expect(refreshButton?.style.minWidth).toBe("44px");
    expect(refreshButton?.style.minHeight).toBe("44px");
  });

  it("keeps historical duel identity compact while preserving the full id", async () => {
    const payload = historyPayload();
    const fullDuelId = "streaming-e354197c-6db9-43af-90d6-9ae5d9898485";
    payload.entries[0]!.duelId = fullDuelId;
    payload.entries[0]!.correlationId = buildDuelCorrelationId({
      duelId: fullDuelId,
      duelKey: payload.entries[0]!.duelKey,
    });
    globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
      />,
    );
    await flushEffects();

    const identity = container.querySelector(
      '[data-testid="solana-settlement-identity-bet-1"]',
    );
    expect(identity?.textContent).toBe("YES · e35419…8485");
    expect(identity?.getAttribute("title")).toBe(fullDuelId);
    expect(identity?.getAttribute("style")).toContain("white-space: nowrap");
  });

  it("describes a locked filled order as settlement pending without denying the visible duel result", async () => {
    const awaitingSettlement = historyPayload();
    Object.assign(awaitingSettlement.entries[0]!, {
      marketStatus: "locked",
      winner: "none",
      orderState: "FILLED",
      settlementState: "AWAITING_RESULT",
    });
    globalThis.fetch = (async () =>
      Response.json(awaitingSettlement)) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
        onRequestOrderManagement={() => undefined}
      />,
    );
    await flushEffects();

    expect(container.textContent).toContain("Settlement pending");
    expect(container.textContent).not.toContain("Awaiting result");
    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();
  });

  it("refreshes settlement evidence on explicit user request", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      return Response.json(historyPayload());
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
      />,
    );
    await flushEffects();
    expect(requestCount).toBe(1);

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    await act(async () => refreshButton?.click());
    await flushEffects();

    expect(requestCount).toBe(2);
  });

  it("refreshes settlement evidence immediately after a confirmed market mutation", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      const payload = historyPayload();
      Object.assign(payload.entries[0]!, {
        marketStatus: "cancelled",
        winner: "none",
        settlementState: requestCount < 3 ? "REFUND_CLAIMABLE" : "REFUNDED",
        terminalKind: requestCount < 3 ? null : "CANCELLATION_REFUND",
        terminalStatus: requestCount < 3 ? null : "cancelled",
        terminalWinner: requestCount < 3 ? null : "none",
        claimSignature: requestCount < 3 ? null : CLAIM_SIGNATURE,
        terminalGrossLamports: requestCount < 3 ? "0" : "620000000",
        terminalPayoutLamports: requestCount < 3 ? "0" : "620000000",
        settledAt: requestCount < 3 ? null : 1_700_000_000_300,
      });
      return Response.json(payload);
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
      />,
    );
    await flushEffects();

    expect(requestCount).toBe(1);
    expect(container.textContent).toContain("Refund ready to claim");
    expect(container.textContent).toContain("Gross claim0.62 SOL");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).not.toBeNull();

    await act(async () => {
      dispatchHyperbetMarketRefresh({
        schemaVersion: 1,
        mutation: "SETTLEMENT_CONFIRMED",
        wallet: WALLET,
        marketPda: MARKET,
        signature: CLAIM_SIGNATURE,
        kind: "REFUND",
      });
    });
    await flushEffects();

    expect(requestCount).toBe(2);
    expect(container.textContent).toContain("Updating");
    expect(container.textContent).toContain("Checking settlement");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).toBeNull();

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    await act(async () => refreshButton?.click());
    await flushEffects();
    await flushEffects();

    expect(requestCount).toBe(3);
    expect(container.textContent).toContain("Refund paid");
    expect(container.textContent).toContain("Claim tx");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).toBeNull();
  });

  it("fails closed while a confirmed winning claim is still indexing", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      const payload = historyPayload();
      Object.assign(payload.entries[0]!, {
        settlementState: requestCount < 3 ? "PAYOUT_CLAIMABLE" : "PAID",
        terminalKind: requestCount < 3 ? null : "CLAIM_PAYOUT",
        terminalStatus: requestCount < 3 ? null : "resolved",
        terminalWinner: requestCount < 3 ? null : "a",
        claimSignature: requestCount < 3 ? null : WINNER_CLAIM_SIGNATURE,
        terminalGrossLamports: requestCount < 3 ? "0" : "1000000000",
        terminalPayoutLamports: requestCount < 3 ? "0" : "980000000",
        terminalFeeLamports: requestCount < 3 ? "0" : "20000000",
        settledAt: requestCount < 3 ? null : 1_700_000_000_300,
      });
      return Response.json(payload);
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
      />,
    );
    await flushEffects();

    expect(container.textContent).toContain("Winnings ready to claim");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).not.toBeNull();

    await act(async () => {
      dispatchHyperbetMarketRefresh({
        schemaVersion: 1,
        mutation: "SETTLEMENT_CONFIRMED",
        wallet: WALLET,
        marketPda: MARKET,
        signature: WINNER_CLAIM_SIGNATURE,
        kind: "CLAIM",
      });
    });
    await flushEffects();

    expect(requestCount).toBe(2);
    expect(container.textContent).toContain("Updating");
    expect(container.textContent).toContain("Checking settlement");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).toBeNull();

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    await act(async () => refreshButton?.click());
    await flushEffects();
    await flushEffects();

    expect(requestCount).toBe(3);
    expect(container.textContent).toContain("Winnings paid");
    expect(container.textContent).toContain("Claim tx");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).toBeNull();
  });

  it("does not carry a pending confirmation into another wallet session", async () => {
    globalThis.fetch = (async (input) => {
      const requestWallet = decodeURIComponent(
        new URL(String(input)).pathname.split("/").at(-1)!,
      );
      const payload = historyPayload();
      payload.wallet = requestWallet;
      payload.entries[0]!.wallet = requestWallet;
      return Response.json(payload);
    }) as typeof fetch;

    function WalletSwitchingHistory() {
      const [walletAddress, setWalletAddress] = useState(WALLET);
      return (
        <>
          <button
            data-testid="switch-settlement-wallet"
            onClick={() => setWalletAddress(OTHER_WALLET)}
            type="button"
          >
            Switch wallet
          </button>
          <SolanaSettlementHistory
            walletAddress={walletAddress}
            agent1Name="Nova"
            agent2Name="Rook"
            onRequestSettlement={() => undefined}
          />
        </>
      );
    }

    const { container } = render(<WalletSwitchingHistory />);
    await flushEffects();

    await act(async () => {
      dispatchHyperbetMarketRefresh({
        schemaVersion: 1,
        mutation: "SETTLEMENT_CONFIRMED",
        wallet: WALLET,
        marketPda: MARKET,
        signature: WINNER_CLAIM_SIGNATURE,
        kind: "CLAIM",
      });
    });
    await flushEffects();
    expect(container.textContent).toContain("Updating");

    const switchButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="switch-settlement-wallet"]',
    );
    await act(async () => switchButton?.click());
    await flushEffects();

    expect(container.textContent).toContain("Verified");
    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).not.toBeNull();
  });

  it("never presents stale settlement data as final", async () => {
    globalThis.fetch = (async () =>
      Response.json(historyPayload(false))) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        marketPda={MARKET}
        agent1Name="Nova"
        agent2Name="Rook"
      />,
    );
    await flushEffects();

    expect(container.textContent).toContain("Updating");
    expect(container.textContent).toContain("Checking settlement");
    expect(container.textContent).toContain("not presented as final");
    expect(container.textContent).not.toContain("Winnings ready to claim");
  });

  it("revokes every action when a later history response changes deployment", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      const response = historyPayload();
      if (requestCount > 1) {
        response.programId = key(9);
      }
      return Response.json(response);
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
        onRequestOrderManagement={() => undefined}
      />,
    );
    await flushEffects();

    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).not.toBeNull();

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    await act(async () => refreshButton?.click());
    await flushEffects();

    expect(requestCount).toBe(2);
    expect(container.textContent).toContain("Updating");
    expect(container.textContent).toContain("not presented as final");
    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-balance-rent-action-"]'),
    ).toBeNull();
  });

  it("revokes every action when a later history response is replayed past its freshness window", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      const response = historyPayload();
      if (requestCount > 1) {
        response.updatedAt = Date.now() - 30_001;
        response.ledger.lastIndexedAt = response.updatedAt - 100;
      }
      return Response.json(response);
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
        onRequestOrderManagement={() => undefined}
        onRequestBalanceCleanup={() => undefined}
      />,
    );
    await flushEffects();

    expect(
      container.querySelector('[data-testid="solana-settlement-action-bet-1"]'),
    ).not.toBeNull();

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    await act(async () => refreshButton?.click());
    await flushEffects();

    expect(requestCount).toBe(2);
    expect(container.textContent).toContain("Updating");
    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-balance-rent-action-"]'),
    ).toBeNull();
  });

  it("offers an exact verified prior-market settlement target", async () => {
    globalThis.fetch = (async () =>
      Response.json(historyPayload())) as typeof fetch;
    const requests: unknown[] = [];

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={(request) => requests.push(request)}
      />,
    );
    await flushEffects();

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-action-bet-1"]',
    );
    expect(button?.textContent).toContain("Claim winnings");
    await act(async () => button?.click());
    expect(requests).toEqual([
      {
        betId: "bet-1",
        marketPda: MARKET,
        duelKey: "ab".repeat(32),
        duelId: "duel-1",
        settlementState: "PAYOUT_CLAIMABLE",
      },
    ]);
  });

  it("offers exactly one prior-market loser cleanup and defers filled-order rent", async () => {
    const losing = historyPayload();
    Object.assign(losing.entries[0]!, {
      winner: "b",
      settlementState: "LOST",
    });
    losing.entries.push({
      ...losing.entries[0]!,
      betId: "bet-2",
      orderId: "8",
      placeSignature: signature(8),
    });
    losing.total = 2;
    globalThis.fetch = (async () => Response.json(losing)) as typeof fetch;
    const settlementRequests: unknown[] = [];

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={(request) => settlementRequests.push(request)}
        onRequestOrderManagement={() => {
          throw new Error("order-rent recovery must wait for position cleanup");
        }}
      />,
    );
    await flushEffects();

    const cleanupButtons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="solana-settlement-action-"]',
    );
    expect(cleanupButtons).toHaveLength(1);
    expect(cleanupButtons[0]?.textContent).toContain("Clear position");
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();
    await act(async () => cleanupButtons[0]?.click());
    expect(settlementRequests).toEqual([
      {
        betId: "bet-1",
        marketPda: MARKET,
        duelKey: "ab".repeat(32),
        duelId: "duel-1",
        settlementState: "LOST",
      },
    ]);
  });

  it("prioritizes one winning claim over losing rows from the same wallet market", async () => {
    const mixed = historyPayload();
    Object.assign(mixed.entries[0]!, {
      winner: "b",
      settlementState: "LOST",
    });
    mixed.entries.push({
      ...mixed.entries[0]!,
      betId: "bet-2",
      orderId: "8",
      placeSignature: signature(8),
      side: 2,
      limitPrice: 400,
      settlementState: "PAYOUT_CLAIMABLE",
    });
    mixed.total = 2;
    globalThis.fetch = (async () => Response.json(mixed)) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
        onRequestOrderManagement={() => undefined}
      />,
    );
    await flushEffects();

    const actions = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="solana-settlement-action-"]',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.dataset.testid).toBe("solana-settlement-action-bet-2");
    expect(actions[0]?.textContent).toContain("Claim winnings");
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();
  });

  it("fails closed after cleanup confirmation until terminal history is indexed", async () => {
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      const losing = historyPayload();
      Object.assign(losing.entries[0]!, {
        winner: "b",
        settlementState: "LOST",
        terminalKind: requestCount < 3 ? null : "LOSER_CLEANUP",
        terminalStatus: requestCount < 3 ? null : "resolved",
        terminalWinner: requestCount < 3 ? null : "b",
        claimSignature: requestCount < 3 ? null : LOSER_CLEANUP_SIGNATURE,
        settledAt: requestCount < 3 ? null : 1_700_000_000_300,
      });
      return Response.json(losing);
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => undefined}
        onRequestOrderManagement={() => undefined}
      />,
    );
    await flushEffects();
    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).not.toBeNull();

    await act(async () => {
      dispatchHyperbetMarketRefresh({
        schemaVersion: 1,
        mutation: "SETTLEMENT_CONFIRMED",
        wallet: WALLET,
        marketPda: MARKET,
        signature: LOSER_CLEANUP_SIGNATURE,
        kind: "CLEANUP",
      });
    });
    await flushEffects();

    expect(requestCount).toBe(2);
    expect(container.textContent).toContain("Updating");
    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-refresh"]',
    );
    await act(async () => refreshButton?.click());
    await flushEffects();
    await flushEffects();

    expect(requestCount).toBe(3);
    expect(container.textContent).toContain("Position closed · no payout");
    expect(container.textContent).toContain("Cleanup tx");
    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).not.toBeNull();
  });

  it("never offers a stale or identity-incomplete settlement action", async () => {
    const stale = historyPayload(false);
    stale.entries[0]!.duelKey = null;
    globalThis.fetch = (async () => Response.json(stale)) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestSettlement={() => {
          throw new Error("stale settlement must not be actionable");
        }}
      />,
    );
    await flushEffects();

    expect(
      container.querySelector('[data-testid^="solana-settlement-action-"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="solana-order-history-action-"]'),
    ).toBeNull();
  });

  it("offers exact prior-market resting-order recovery without binding to the live market", async () => {
    const reclaimable = historyPayload();
    Object.assign(reclaimable.entries[0]!, {
      matchedAmountUnits: "500000000",
      restingAmountUnits: "500000000",
      executedCostLamports: "300000000",
      tradeFeeLamports: "10000000",
      sourceAmountLamports: "610000000",
      rewardEligibleLamports: "310000000",
      marketStatus: "cancelled",
      winner: "none",
      orderState: "RECLAIM_REQUIRED",
      settlementState: "REFUND_CLAIMABLE",
    });
    globalThis.fetch = (async () => Response.json(reclaimable)) as typeof fetch;
    const requests: unknown[] = [];
    let requestTrigger: HTMLButtonElement | null = null;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestOrderManagement={(request, trigger) => {
          requests.push(request);
          requestTrigger = trigger;
        }}
      />,
    );
    await flushEffects();

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-order-history-action-bet-1"]',
    );
    expect(container.textContent).toContain("Reclaim required");
    expect(container.textContent).toContain("Gross claim0.31 SOL");
    expect(button?.textContent).toContain("Reclaim resting order");
    expect(button?.style.minHeight).toBe("44px");
    await act(async () => button?.click());
    expect(requests).toEqual([
      {
        betId: "bet-1",
        marketPda: MARKET,
        duelKey: "ab".repeat(32),
        duelId: "duel-1",
        orderId: "7",
        orderState: "RECLAIM_REQUIRED",
      },
    ]);
    expect(requestTrigger as HTMLButtonElement | null).toBe(button);
  });

  it("offers one terminal balance-rent recovery action per released market", async () => {
    const released = historyPayload();
    Object.assign(released.entries[0]!, {
      matchedAmountUnits: "0",
      restingAmountUnits: "0",
      releasedAmountUnits: "1000000000",
      sourceAmountLamports: "600000000",
      collateralLamports: "600000000",
      executedCostLamports: "0",
      tradeFeeLamports: "0",
      orderRefundLamports: "600000000",
      rewardEligibleLamports: "0",
      marketStatus: "cancelled",
      winner: "none",
      orderState: "RELEASED",
      settlementState: "NO_ENTITLEMENT",
    });
    const duplicateMarketEntry = {
      ...released.entries[0]!,
      betId: "bet-2",
      orderId: "8",
      placeSignature: signature(8),
    };
    released.entries.push(duplicateMarketEntry);
    released.total = 2;
    globalThis.fetch = (async () => Response.json(released)) as typeof fetch;
    const requests: unknown[] = [];

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        onRequestBalanceCleanup={(request) => requests.push(request)}
      />,
    );
    await flushEffects();

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid^="solana-balance-rent-action-"]',
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("Recover account rent");
    await act(async () => buttons[0]?.click());
    expect(requests).toEqual([
      {
        betId: "bet-1",
        marketPda: MARKET,
        duelKey: "ab".repeat(32),
        duelId: "duel-1",
      },
    ]);
  });

  it("never offers balance-rent recovery from stale, open, or nonreleased history", async () => {
    for (const variant of [
      { current: false, marketStatus: "cancelled", orderState: "RELEASED" },
      { current: true, marketStatus: "open", orderState: "RELEASED" },
      { current: true, marketStatus: "cancelled", orderState: "FILLED" },
    ] as const) {
      const payload = historyPayload(variant.current);
      Object.assign(payload.entries[0]!, {
        marketStatus: variant.marketStatus,
        orderState: variant.orderState,
        settlementState: "NO_ENTITLEMENT",
      });
      globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
      const { container, unmount } = render(
        <SolanaSettlementHistory
          walletAddress={WALLET}
          agent1Name="Nova"
          agent2Name="Rook"
          onRequestBalanceCleanup={() => {
            throw new Error("ineligible account rent must not be actionable");
          }}
        />,
      );
      await flushEffects();
      expect(
        container.querySelector('[data-testid^="solana-balance-rent-action-"]'),
      ).toBeNull();
      unmount();
    }
  });

  it("stays private and idle until a wallet is connected", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json(historyPayload());
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={null}
        marketPda={MARKET}
        agent1Name="Nova"
        agent2Name="Rook"
      />,
    );
    await flushEffects();

    expect(fetchCount).toBe(0);
    expect(container.textContent).toContain("Connect your wallet");
  });

  it("loads older wallet activity instead of hiding it behind the first page", async () => {
    const first = historyPayload();
    const secondEntry = {
      ...first.entries[0]!,
      betId: "bet-2",
      orderId: "8",
      duelId: "duel-2",
      correlationId: buildDuelCorrelationId({
        duelId: "duel-2",
        duelKey: first.entries[0]!.duelKey,
      }),
      placeSignature: signature(8),
      recordedAt: 1_699_999_999_000,
    };
    const thirdEntry = {
      ...first.entries[0]!,
      betId: "bet-3",
      orderId: "9",
      duelId: "duel-3",
      correlationId: buildDuelCorrelationId({
        duelId: "duel-3",
        duelKey: first.entries[0]!.duelKey,
      }),
      placeSignature: signature(9),
      recordedAt: 1_699_999_998_000,
    };
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      const limit = Number(new URL(url).searchParams.get("limit"));
      return Response.json({
        ...first,
        entries:
          limit <= 2
            ? [first.entries[0]!, secondEntry]
            : [first.entries[0]!, secondEntry, thirdEntry],
        total: 3,
        limit,
      });
    }) as typeof fetch;

    const { container } = render(
      <SolanaSettlementHistory
        walletAddress={WALLET}
        agent1Name="Nova"
        agent2Name="Rook"
        compact
      />,
    );
    await flushEffects();

    const loadMore = container.querySelector<HTMLButtonElement>(
      '[data-testid="solana-settlement-load-more"]',
    );
    expect(loadMore?.textContent).toContain("Show more activity (1)");
    await act(async () => loadMore?.click());
    await flushEffects();

    expect(
      container.querySelectorAll('[data-testid="solana-settlement-entry"]'),
    ).toHaveLength(3);
    expect(requests.some((url) => url.includes("limit=4"))).toBe(true);
    expect(
      container.querySelector('[data-testid="solana-settlement-load-more"]'),
    ).toBeNull();
  });
});
