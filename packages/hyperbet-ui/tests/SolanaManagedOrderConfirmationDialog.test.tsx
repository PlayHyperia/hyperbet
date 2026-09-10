import "./setup";
import { describe, expect, it } from "bun:test";

import { SolanaManagedOrderConfirmationDialog } from "../src/components/SolanaManagedOrderConfirmationDialog";
import type { SolanaManagedOrderPlan } from "../src/lib/solanaOrderManagement";
import { click, getByTestId, render } from "./render";

const order: SolanaManagedOrderPlan = {
  action: "CANCEL",
  marketState: "market",
  orderId: 7n,
  side: 1,
  outcomeSide: "YES",
  outcomePriceMillis: 600,
  programPriceMillis: 600,
  originalUnits: 2_000_000_000n,
  filledUnits: 500_000_000n,
  remainingUnits: 1_500_000_000n,
  refundableCollateralLamports: 900_000_000n,
  returnedOrderAccountRentLamports: 1_719_120n,
  grossWalletCreditLamports: 901_719_120n,
  previousOrderId: 6n,
  nextOrderId: 8n,
  adjacentOrderIds: [6n, 8n],
  continuationPending: false,
};

describe("SolanaManagedOrderConfirmationDialog", () => {
  it("shows exact cancellation terms and invokes explicit actions", () => {
    let backedOut = false;
    let confirmed = false;
    let escapedToParent = false;
    const { container } = render(
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") escapedToParent = true;
        }}
      >
        <SolanaManagedOrderConfirmationDialog
          order={order}
          onBack={() => {
            backedOut = true;
          }}
          onConfirm={() => {
            confirmed = true;
          }}
        />
      </div>,
    );

    const dialog = getByTestId(container, "solana-managed-order-confirmation");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.style.maxHeight).toBe("min(calc(100dvh - 32px), 720px)");
    expect(dialog.style.overflowY).toBe("auto");
    expect(dialog.style.overscrollBehavior).toBe("contain");
    expect(dialog.style.boxSizing).toBe("border-box");
    expect(container.textContent).toContain("Confirm order cancellation");
    expect(container.textContent).toContain("YES 60.0%");
    expect(container.textContent).toContain("1.5");
    expect(container.textContent).toContain("0.9 SOL");
    expect(container.textContent).toContain("0.00171912 SOL");
    expect(container.textContent).toContain("0.90171912 SOL");
    expect(container.textContent).toContain(
      "returns only to its original maker",
    );
    expect(container.textContent).toContain(
      "shared PriceLevel rent is excluded",
    );
    const backButton = getByTestId(
      container,
      "solana-managed-order-confirmation-back",
    ) as HTMLButtonElement;
    const confirmButton = getByTestId(
      container,
      "solana-managed-order-confirmation-submit",
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(backButton);
    expect(backButton.style.minHeight).toBe("44px");
    expect(document.activeElement).not.toBe(confirmButton);
    expect(confirmButton.style.minHeight).toBe("44px");
    expect(
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(false);
    expect(backedOut).toBe(true);
    expect(escapedToParent).toBe(false);
    backedOut = false;
    click(backButton);
    click(confirmButton);
    expect(backedOut).toBe(true);
    expect(confirmed).toBe(true);
  });

  it("localizes reclaim copy and locks both choices while submitting", () => {
    const { container } = render(
      <SolanaManagedOrderConfirmationDialog
        order={{ ...order, action: "RECLAIM" }}
        submitting
        locale="zh"
        onBack={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(container.textContent).toContain("确认收回挂单");
    expect(container.textContent).toContain("处理中");
    expect(container.textContent).toContain("该订单账户租金仅返还原始挂单者");
    expect(container.textContent).toContain("共享价格档账户租金不包含在内");
    expect(
      (
        getByTestId(
          container,
          "solana-managed-order-confirmation-back",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        getByTestId(
          container,
          "solana-managed-order-confirmation-submit",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("explains fully filled order cleanup without claiming collateral movement", () => {
    const { container } = render(
      <SolanaManagedOrderConfirmationDialog
        order={{
          ...order,
          action: "CLOSE_FILLED",
          filledUnits: order.originalUnits,
          remainingUnits: 0n,
          refundableCollateralLamports: 0n,
          grossWalletCreditLamports: order.returnedOrderAccountRentLamports,
          previousOrderId: 0n,
          nextOrderId: 0n,
          adjacentOrderIds: [],
        }}
        onBack={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(container.textContent).toContain(
      "Confirm filled-order rent recovery",
    );
    expect(container.textContent).toContain(
      "cannot move collateral or shared PriceLevel rent",
    );
    expect(container.textContent).not.toContain("Unmatched collateral return");
    expect(
      getByTestId(container, "solana-managed-order-confirmation-submit")
        .textContent,
    ).toContain("Confirm rent recovery and sign");
  });
});
