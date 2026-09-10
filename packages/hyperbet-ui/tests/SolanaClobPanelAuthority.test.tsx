import "./setup";
import { useState } from "react";
import { describe, expect, it } from "bun:test";

import {
  failClosedSolanaClobMarketSnapshot,
  normalizeSolanaCompetitiveSnapshotCommitment,
} from "../src/components/SolanaClobPanel";
import {
  createSolanaWagerAuthorityBoundary,
  restoreSolanaOrderConfirmationFocus,
  runSolanaWagerPreBroadcastFlow,
  SolanaWagerAuthorityChangedError,
  useInvalidateSolanaOrderConfirmationOnTradingDisabled,
} from "../src/lib/useSolanaOrderConfirmationAuthorityBoundary";
import { classifySolanaTransactionError } from "../src/lib/solanaTransactionFeedback";
import { click, getByTestId, render } from "./render";

function ConfirmationHarness({
  onInvalidate,
  onSign,
  receipt,
}: {
  onInvalidate: () => void;
  onSign: () => void;
  receipt?: string;
}) {
  const [tradingEnabled, setTradingEnabled] = useState(true);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  useInvalidateSolanaOrderConfirmationOnTradingDisabled({
    tradingEnabled,
    confirmationOpen,
    onInvalidate: () => {
      setConfirmationOpen(false);
      onInvalidate();
    },
  });

  return (
    <div>
      <button
        type="button"
        data-testid="disable-trading"
        onClick={() => setTradingEnabled(false)}
      >
        Disable trading
      </button>
      <button
        type="button"
        data-testid="enable-trading"
        onClick={() => setTradingEnabled(true)}
      >
        Enable trading
      </button>
      {tradingEnabled ? (
        <button
          type="button"
          data-testid="review-order"
          onClick={() => setConfirmationOpen(true)}
        >
          Review order
        </button>
      ) : null}
      {confirmationOpen ? (
        <button
          type="button"
          data-testid="confirm-and-sign"
          disabled={!tradingEnabled}
          onClick={onSign}
        >
          Confirm and sign
        </button>
      ) : null}
      {receipt ? (
        <output data-testid="transaction-receipt">{receipt}</output>
      ) : null}
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SolanaClobPanel trading authority boundary", () => {
  it("normalizes only a complete nonzero on-chain competitive commitment", () => {
    const digest = new Uint8Array(32).fill(7);
    expect(
      normalizeSolanaCompetitiveSnapshotCommitment({
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: digest,
      }),
    ).toEqual({
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "07".repeat(32),
    });
    expect(
      normalizeSolanaCompetitiveSnapshotCommitment({
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: Array.from(digest),
      }),
    ).toEqual({
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "07".repeat(32),
    });
    expect(
      normalizeSolanaCompetitiveSnapshotCommitment({
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: Buffer.from(digest),
      }),
    ).toEqual({
      competitiveSnapshotVersion: 4,
      competitiveSnapshotDigest: "07".repeat(32),
    });

    for (const invalid of [
      {
        competitiveSnapshotVersion: "4",
        competitiveSnapshotDigest: digest,
      },
      {
        competitiveSnapshotVersion: 0,
        competitiveSnapshotDigest: digest,
      },
      {
        competitiveSnapshotVersion: -1,
        competitiveSnapshotDigest: digest,
      },
      {
        competitiveSnapshotVersion: 1.5,
        competitiveSnapshotDigest: digest,
      },
      {
        competitiveSnapshotVersion: Number.NaN,
        competitiveSnapshotDigest: digest,
      },
      {
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: new Uint8Array(31).fill(7),
      },
      {
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: new Uint8Array(33).fill(7),
      },
      {
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: new Uint8Array(32),
      },
      {
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: [256, ...new Array(31).fill(7)],
      },
      {
        competitiveSnapshotVersion: 4,
        competitiveSnapshotDigest: "07".repeat(32),
      },
    ]) {
      expect(normalizeSolanaCompetitiveSnapshotCommitment(invalid)).toBeNull();
    }
  });

  it("retains same-duel recovery identity but clears stale wager authority", () => {
    const snapshot = {
      duelKeyHex: "aa".repeat(32),
      marketStatus: "open",
      winner: "A" as string | null,
      tradingReady: true,
      competitiveSnapshotVersion: 4 as number | null,
      competitiveSnapshotDigest: "07".repeat(32) as string | null,
      marketRef: "retained-market",
    };

    const failedClosed = {
      ...snapshot,
      marketStatus: "unavailable",
      winner: null,
      tradingReady: false,
      competitiveSnapshotVersion: null,
      competitiveSnapshotDigest: null,
    };
    expect(
      failClosedSolanaClobMarketSnapshot(snapshot, `0x${"AA".repeat(32)}`),
    ).toEqual(failedClosed);
    expect(
      failClosedSolanaClobMarketSnapshot(snapshot, "aa".repeat(32)),
    ).toEqual(failedClosed);
    expect(
      failClosedSolanaClobMarketSnapshot(snapshot, "bb".repeat(32)),
    ).toBeNull();
    expect(failClosedSolanaClobMarketSnapshot(snapshot, null)).toBeNull();
  });

  it("restores focus to a stable panel when the order trigger was removed", () => {
    const removedTrigger = document.createElement("button");
    const stablePanel = document.createElement("div");
    stablePanel.tabIndex = -1;
    document.body.append(stablePanel);

    restoreSolanaOrderConfirmationFocus(removedTrigger, stablePanel);

    expect(document.activeElement).toBe(stablePanel);
  });

  it("requires a fresh explicit review after trading authority recovers", () => {
    let invalidations = 0;
    let signatures = 0;
    const props = {
      onInvalidate: () => {
        invalidations += 1;
      },
      onSign: () => {
        signatures += 1;
      },
    };
    const view = render(<ConfirmationHarness {...props} />);

    click(getByTestId(view.container, "review-order"));
    expect(
      view.container.querySelector('[data-testid="confirm-and-sign"]'),
    ).not.toBeNull();

    click(getByTestId(view.container, "disable-trading"));
    expect(invalidations).toBe(1);
    expect(signatures).toBe(0);
    expect(
      view.container.querySelector('[data-testid="confirm-and-sign"]'),
    ).toBeNull();

    click(getByTestId(view.container, "enable-trading"));
    expect(invalidations).toBe(1);
    expect(signatures).toBe(0);
    expect(
      view.container.querySelector('[data-testid="confirm-and-sign"]'),
    ).toBeNull();

    click(getByTestId(view.container, "review-order"));
    click(getByTestId(view.container, "confirm-and-sign"));
    expect(signatures).toBe(1);
  });

  it("closes a stale confirmation without discarding a retained receipt", () => {
    let invalidations = 0;
    const view = render(
      <ConfirmationHarness
        onInvalidate={() => {
          invalidations += 1;
        }}
        onSign={() => undefined}
        receipt="retained-signature"
      />,
    );
    click(getByTestId(view.container, "review-order"));

    click(getByTestId(view.container, "disable-trading"));

    expect(invalidations).toBe(1);
    expect(
      view.container.querySelector('[data-testid="confirm-and-sign"]'),
    ).toBeNull();
    expect(getByTestId(view.container, "transaction-receipt").textContent).toBe(
      "retained-signature",
    );
  });

  it("does not revive a reviewed authority epoch after disable and recovery", async () => {
    const authority = createSolanaWagerAuthorityBoundary(true);
    const epoch = authority.capture();
    expect(epoch).not.toBeNull();
    let signatureRequests = 0;
    let broadcasts = 0;

    authority.update(false);
    authority.update(true);

    let thrown: unknown = null;
    try {
      await runSolanaWagerPreBroadcastFlow({
        authority,
        epoch: epoch!,
        requestSignature: async () => {
          signatureRequests += 1;
          return "signed";
        },
        startBroadcast: async () => {
          broadcasts += 1;
          return "broadcast";
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SolanaWagerAuthorityChangedError);
    expect(classifySolanaTransactionError(thrown)).toMatchObject({
      kind: "QUOTE_STALE",
      stage: "preparing",
      signature: null,
      retryMode: "REVIEW_AND_RETRY",
    });
    expect(signatureRequests).toBe(0);
    expect(broadcasts).toBe(0);
  });

  it("does not broadcast when authority is lost while the wallet prompt is pending", async () => {
    const authority = createSolanaWagerAuthorityBoundary(true);
    const epoch = authority.capture();
    expect(epoch).not.toBeNull();
    const signatureStarted = deferred<void>();
    const signedTransaction = deferred<string>();
    let broadcasts = 0;

    const flow = runSolanaWagerPreBroadcastFlow({
      authority,
      epoch: epoch!,
      requestSignature: async () => {
        signatureStarted.resolve();
        return signedTransaction.promise;
      },
      startBroadcast: async () => {
        broadcasts += 1;
        return "broadcast";
      },
    });
    await signatureStarted.promise;
    authority.update(false);
    authority.update(true);
    signedTransaction.resolve("signed");

    let thrown: unknown = null;
    try {
      await flow;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SolanaWagerAuthorityChangedError);
    expect(broadcasts).toBe(0);
  });

  it("preserves reconciliation after raw broadcast has started", async () => {
    const authority = createSolanaWagerAuthorityBoundary(true);
    const epoch = authority.capture();
    expect(epoch).not.toBeNull();
    const broadcastStarted = deferred<void>();
    const broadcastCompleted = deferred<string>();
    let broadcasts = 0;

    const flow = runSolanaWagerPreBroadcastFlow({
      authority,
      epoch: epoch!,
      requestSignature: async () => "signed",
      startBroadcast: async () => {
        broadcasts += 1;
        broadcastStarted.resolve();
        return broadcastCompleted.promise;
      },
    });
    await broadcastStarted.promise;
    authority.update(false);
    authority.update(true);
    broadcastCompleted.resolve("confirmed-signature");

    expect(await flow).toBe("confirmed-signature");
    expect(broadcasts).toBe(1);
  });
});
