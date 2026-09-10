import "./setup";
import React from "react";
import { afterEach, describe, expect, it, mock } from "bun:test";

import { SolanaSettlementActionCard } from "../src/components/SolanaSettlementActionCard";
import { cleanupRenderedTrees, click, getByTestId, render } from "./render";

afterEach(cleanupRenderedTrees);

const baseProps = {
  eyebrow: "Winnings ready",
  title: "Claim winnings",
  helpText: "Your winning shares have settled and are ready to claim.",
  amountLabel: "Claimable now",
  amountText: "1.425 SOL",
  buttonLabel: "Claim",
  processingLabel: "Processing…",
  isProcessing: false,
  onAction: () => undefined,
};

describe("SolanaSettlementActionCard", () => {
  it.each([
    ["winnings", "Winnings ready", "Claim winnings", "1.425 SOL"],
    ["refund", "Refund ready", "Claim refund", "0.800 SOL"],
    ["cleanup", "Cleanup required", "Clear resolved position", null],
    ["rent", "Rent recovery", "Recover account rent", null],
  ] as const)(
    "exposes an unambiguous %s terminal state",
    (kind, eyebrow, title, amountText) => {
      const { container } = render(
        <SolanaSettlementActionCard
          {...baseProps}
          kind={kind}
          eyebrow={eyebrow}
          title={title}
          amountText={amountText}
        />,
      );

      const card = getByTestId(container, "solana-settlement-action");
      expect(card.dataset.kind).toBe(kind);
      expect(card.dataset.state).toBe("ready");
      expect(card.getAttribute("aria-labelledby")).toBeTruthy();
      expect(card.getAttribute("aria-describedby")).toBeTruthy();
      expect(card.textContent).toContain(eyebrow);
      expect(card.textContent).toContain(title);
      expect(
        card.querySelector('[data-testid="solana-settlement-action-amount"]')
          ?.textContent ?? null,
      ).toBe(amountText === null ? null : `Claimable now${amountText}`);
    },
  );

  it("invokes the requested settlement action exactly once", () => {
    const onAction = mock(() => undefined);
    const { container } = render(
      <SolanaSettlementActionCard
        {...baseProps}
        kind="winnings"
        onAction={onAction}
        actionTestId="claim-action"
      />,
    );

    const action = getByTestId(container, "claim-action") as HTMLButtonElement;
    expect(action.style.minHeight).toBe("44px");
    click(action);

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("announces processing and prevents duplicate submission", () => {
    const onAction = mock(() => undefined);
    const { container } = render(
      <SolanaSettlementActionCard
        {...baseProps}
        kind="refund"
        isProcessing
        onAction={onAction}
        actionTestId="refund-action"
      />,
    );

    const card = getByTestId(container, "solana-settlement-action");
    const action = getByTestId(container, "refund-action") as HTMLButtonElement;
    expect(card.dataset.state).toBe("processing");
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(action.disabled).toBe(true);
    expect(action.getAttribute("aria-live")).toBe("polite");
    expect(action.getAttribute("aria-atomic")).toBe("true");
    expect(action.textContent).toBe("Processing…");

    click(action);
    expect(onAction).not.toHaveBeenCalled();
  });
});
