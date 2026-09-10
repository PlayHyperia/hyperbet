import "./setup";
import { describe, expect, it } from "bun:test";
import type { ComponentProps } from "react";

import { PredictionMarketPanel } from "../src/components/PredictionMarketPanel";
import { changeValue, click, getByTestId, render } from "./render";

function renderPanel(
  overrides: Partial<ComponentProps<typeof PredictionMarketPanel>> = {},
) {
  const sideChanges: string[] = [];
  const amountChanges: string[] = [];
  let placedBets = 0;
  let betTrigger: HTMLButtonElement | null = null;

  const rendered = render(
    <PredictionMarketPanel
      yesPercent={55}
      noPercent={45}
      yesPool={125}
      noPool={75}
      side="YES"
      setSide={(side) => sideChanges.push(side)}
      amountInput="100"
      setAmountInput={(value) => amountChanges.push(value)}
      onPlaceBet={(trigger) => {
        placedBets += 1;
        betTrigger = trigger;
      }}
      isWalletReady
      programsReady
      agent1Name="Alpha"
      agent2Name="Bravo"
      compact
      {...overrides}
    />,
  );

  return {
    container: rendered.container,
    sideChanges,
    amountChanges,
    get placedBets() {
      return placedBets;
    },
    get betTrigger() {
      return betTrigger;
    },
  };
}

describe("PredictionMarketPanel", () => {
  it("submits buy-side interactions through the provided handlers", () => {
    const state = renderPanel();
    const { container } = state;

    click(getByTestId(container, "prediction-select-no"));
    changeValue(
      getByTestId(container, "prediction-amount-input") as HTMLInputElement,
      "250.5",
    );
    click(getByTestId(container, "prediction-submit"));

    expect(getByTestId(container, "prediction-submit").textContent).toContain(
      "BUY YES",
    );
    expect(state.sideChanges).toEqual(["NO"]);
    expect(state.placedBets).toBe(1);
    expect(state.betTrigger).toBe(
      getByTestId(container, "prediction-submit") as HTMLButtonElement,
    );
  });

  it("disables buying when the wallet is unavailable", () => {
    const { container } = renderPanel({ isWalletReady: false });

    const submit = getByTestId(container, "prediction-submit");
    expect(submit.textContent).toContain("CONNECT WALLET");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders public matchup data without transaction controls in spectator mode", () => {
    const state = renderPanel({ readOnly: true });
    const { container } = state;

    expect(container.textContent).toContain(
      "Spectator mode · transaction controls disabled",
    );
    expect(container.querySelector('[data-testid="prediction-tab-buy"]')).toBe(
      null,
    );
    expect(
      container.querySelector('[data-testid="prediction-amount-input"]'),
    ).toBe(null);
    expect(container.querySelector('[data-testid="prediction-submit"]')).toBe(
      null,
    );
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Bravo");
    const yesSelection = getByTestId(container, "prediction-select-yes");
    const noSelection = getByTestId(container, "prediction-select-no");
    expect((yesSelection as HTMLButtonElement).disabled).toBe(true);
    expect((noSelection as HTMLButtonElement).disabled).toBe(true);
    click(noSelection);
    expect(state.sideChanges).toEqual([]);
    expect(state.placedBets).toBe(0);
  });

  it("renders an authoritative unavailable reason without exposing order entry", () => {
    const { container } = renderPanel({
      readOnly: true,
      readOnlyMessage: "Betting locked.",
    });

    expect(container.textContent).toContain("Betting locked.");
    expect(container.textContent).not.toContain(
      "Spectator mode · transaction controls disabled",
    );
    expect(container.querySelector('[data-testid="prediction-tab-buy"]')).toBe(
      null,
    );
    expect(
      container.querySelector('[data-testid="prediction-amount-input"]'),
    ).toBe(null);
    expect(container.querySelector('[data-testid="prediction-submit"]')).toBe(
      null,
    );
  });

  it("shows sell-side content only when selling is supported", () => {
    const { container } = renderPanel({
      supportsSell: true,
      children: <div>Sell controls</div>,
    });

    const sellTab = getByTestId(container, "prediction-tab-sell");
    expect((sellTab as HTMLButtonElement).disabled).toBe(false);

    click(sellTab);

    expect(container.textContent).toContain("Sell controls");
  });

  it("renders localized Chinese action labels and SOL denomination text", () => {
    const { container } = renderPanel({
      locale: "zh",
      currencySymbol: "SOL",
    });

    expect(getByTestId(container, "prediction-tab-buy").textContent).toContain(
      "买入",
    );
    expect(getByTestId(container, "prediction-tab-sell").textContent).toContain(
      "卖出",
    );
    expect(
      container.querySelector(
        `label[for="${getByTestId(container, "prediction-amount-input").id}"]`,
      )?.textContent,
    ).toBe("下注金额（SOL）");
    expect(getByTestId(container, "prediction-submit").textContent).toContain(
      "买入 YES",
    );
  });

  it("associates the SOL amount constraint and error with a launch-size control", () => {
    const { container } = renderPanel({
      amountHelpText:
        "Enter more than 0 SOL with no more than 6 decimal places.",
      amountError:
        "Enter a SOL amount greater than 0 with no more than 6 decimal places.",
    });
    const input = getByTestId(
      container,
      "prediction-amount-input",
    ) as HTMLInputElement;
    const descriptionIds =
      input.getAttribute("aria-describedby")?.split(" ") ?? [];
    const errorId = input.getAttribute("aria-errormessage");

    expect(
      container.querySelector(`label[for="${input.id}"]`)?.textContent,
    ).toBe("Bet amount in SOL");
    expect(input.min).toBe("0.000001");
    expect(input.step).toBe("0.000001");
    expect(input.style.minHeight).toBe("44px");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionIds).toHaveLength(2);
    expect(errorId).toBe(descriptionIds[1]);
    expect(container.querySelector(`#${errorId}`)?.getAttribute("role")).toBe(
      "alert",
    );
    expect(
      (getByTestId(container, "prediction-submit") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
  });

  it("does not invent probability percentages when a CLOB quote is unavailable", () => {
    const { container } = renderPanel({ yesPercent: null, noPercent: null });
    const yesSelection = getByTestId(container, "prediction-select-yes");
    const noSelection = getByTestId(container, "prediction-select-no");

    expect(yesSelection.textContent).toContain("—");
    expect(noSelection.textContent).toContain("—");
    expect(yesSelection.textContent).not.toContain("50%");
    expect(noSelection.textContent).not.toContain("null%");
  });
});
