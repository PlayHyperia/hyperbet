import "./setup";
import { describe, expect, it } from "bun:test";

import {
  IDLE_SOLANA_TRANSACTION_FEEDBACK,
  SolanaTransactionFeedbackCard,
  type SolanaTransactionFeedbackState,
} from "../src/components/SolanaTransactionFeedbackCard";
import { click, getButtonByText, getByTestId, render } from "./render";

const SIGNATURE =
  "5Vj9v5x5u3P5TtBczYvHh8sjv3wjfNXrjAq9LPG3GJ3c2P7n4qg3pU4y6k4cX1m7hQ9u8F6a5D2s1W3e7R9t8K2";

const BASE_PROPS = {
  cluster: "devnet",
  testId: "transaction-feedback",
  signatureTestId: "transaction-signature",
  signatureLabel: "Transaction signature",
  detailsLabel: "Transaction proof",
  receiptLabel: "View transaction",
  reviewLabel: "Review latest quote",
  checkStatusLabel: "Check transaction status",
};

function errorFeedback(
  overrides: Partial<
    Extract<SolanaTransactionFeedbackState, { status: "error" }>
  > = {},
): Extract<SolanaTransactionFeedbackState, { status: "error" }> {
  return {
    status: "error",
    signature: null,
    warning: null,
    recovery: {
      kind: "USER_REJECTED",
      stage: "signing",
      signature: null,
      retryMode: "REVIEW_AND_RETRY",
      detail: "User rejected the request",
    },
    ...overrides,
  };
}

describe("SolanaTransactionFeedbackCard", () => {
  it("renders nothing while the transaction flow is idle", () => {
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        feedback={IDLE_SOLANA_TRANSACTION_FEEDBACK}
        message={null}
        onReview={() => undefined}
      />,
    );

    expect(container.childElementCount).toBe(0);
  });

  it("announces in-flight progress politely and marks the region busy", () => {
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        feedback={{
          status: "confirming",
          signature: SIGNATURE,
          recovery: null,
          warning: null,
        }}
        message="Transaction sent; waiting for on-chain confirmation"
        onReview={() => undefined}
      />,
    );

    const card = getByTestId(container, "transaction-feedback");
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-live")).toBe("polite");
    expect(card.getAttribute("aria-atomic")).toBe("true");
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(card.getAttribute("data-state")).toBe("confirming");
    expect(container.textContent).toContain("Transaction signature");
  });

  it("renders a complete confirmed receipt and cluster-correct explorer link", () => {
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        feedback={{
          status: "confirmed",
          signature: SIGNATURE,
          recovery: null,
          warning: null,
        }}
        message="Order confirmed on-chain"
        onReview={() => undefined}
      />,
    );

    const card = getByTestId(container, "transaction-feedback");
    const signature = getByTestId(container, "transaction-signature");
    const link = container.querySelector("a");
    expect(card.getAttribute("aria-busy")).toBeNull();
    expect(card.getAttribute("data-state")).toBe("confirmed");
    const details = getByTestId(container, "transaction-feedback-details");
    expect(details.tagName).toBe("DETAILS");
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "Transaction proof",
    );
    expect(details.querySelector("summary")?.getAttribute("style")).toContain(
      "min-height: 44px",
    );
    click(details.querySelector("summary")!);
    expect(details.hasAttribute("open")).toBe(true);
    expect(signature.textContent).toBe(SIGNATURE);
    expect(link?.getAttribute("href")).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.getAttribute("aria-label")).toBe(
      "View transaction: Transaction signature",
    );
    expect(link?.style.display).toBe("inline-flex");
    expect(link?.style.alignItems).toBe("center");
    expect(link?.style.minHeight).toBe("44px");
  });

  it("keeps the full local-validator signature visible without a broken explorer link", () => {
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        cluster="localnet"
        feedback={{
          status: "confirmed",
          signature: SIGNATURE,
          recovery: null,
          warning: null,
        }}
        message="Refund confirmed on-chain"
        onReview={() => undefined}
      />,
    );

    expect(getByTestId(container, "transaction-signature").textContent).toBe(
      SIGNATURE,
    );
    expect(
      getByTestId(container, "transaction-feedback-details").hasAttribute(
        "open",
      ),
    ).toBe(false);
    expect(container.querySelector("a")).toBeNull();
  });

  it("announces deterministic failures assertively and exposes manual review", () => {
    let reviewCount = 0;
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        feedback={errorFeedback()}
        message="Your wallet declined the signature. No transaction was sent."
        onReview={() => {
          reviewCount += 1;
        }}
      />,
    );

    const card = getByTestId(container, "transaction-feedback");
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.getAttribute("aria-live")).toBe("assertive");
    expect(card.getAttribute("aria-busy")).toBeNull();
    const reviewButton = getButtonByText(container, "Review latest quote");
    expect(reviewButton.style.minHeight).toBe("44px");
    click(reviewButton);
    expect(reviewCount).toBe(1);
  });

  it("shows a known signature for ambiguous post-send failures before any retry", () => {
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        feedback={errorFeedback({
          signature: SIGNATURE,
          recovery: {
            kind: "RPC_UNAVAILABLE",
            stage: "confirming",
            signature: SIGNATURE,
            retryMode: "CHECK_STATUS_FIRST",
            detail: "RPC service unavailable",
          },
        })}
        message="The network response was interrupted. Check the transaction before signing again."
        onReview={() => undefined}
      />,
    );

    expect(getByTestId(container, "transaction-signature").textContent).toBe(
      SIGNATURE,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toContain(
      SIGNATURE,
    );
    expect(container.textContent).toContain("Check the transaction");
    expect(
      getButtonByText(container, "Check transaction status"),
    ).not.toBeNull();
  });

  it("keeps confirmed indexing-delay guidance in the same atomic status region", () => {
    const { container } = render(
      <SolanaTransactionFeedbackCard
        {...BASE_PROPS}
        feedback={{
          status: "confirmed",
          signature: SIGNATURE,
          recovery: null,
          warning:
            "Activity indexing is still catching up. Do not place it again.",
        }}
        message="Order confirmed on-chain"
        onReview={() => undefined}
      />,
    );

    const warning = getByTestId(container, "transaction-feedback-warning");
    expect(warning.textContent).toContain("Do not place it again");
    expect(warning.getAttribute("role")).toBeNull();
    expect(warning.closest('[role="status"]')).not.toBeNull();
  });
});
