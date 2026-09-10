import "./setup";
import { describe, expect, it } from "bun:test";

import { SolanaManagedOrders } from "../src/components/SolanaManagedOrders";
import type { SolanaManagedOrderPlan } from "../src/lib/solanaOrderManagement";
import { click, getByTestId, render } from "./render";

const cancelOrder: SolanaManagedOrderPlan = {
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

const reclaimOrder: SolanaManagedOrderPlan = {
  ...cancelOrder,
  action: "RECLAIM",
  orderId: 9n,
  side: 2,
  outcomeSide: "NO",
  outcomePriceMillis: 350,
  programPriceMillis: 650,
  filledUnits: 0n,
  remainingUnits: 2_000_000_000n,
  refundableCollateralLamports: 700_000_000n,
  returnedOrderAccountRentLamports: 1_719_120n,
  grossWalletCreditLamports: 701_719_120n,
  previousOrderId: 0n,
  nextOrderId: 0n,
  adjacentOrderIds: [],
};

const filledOrder: SolanaManagedOrderPlan = {
  ...cancelOrder,
  action: "CLOSE_FILLED",
  orderId: 10n,
  filledUnits: cancelOrder.originalUnits,
  remainingUnits: 0n,
  refundableCollateralLamports: 0n,
  grossWalletCreditLamports: cancelOrder.returnedOrderAccountRentLamports,
  previousOrderId: 0n,
  nextOrderId: 0n,
  adjacentOrderIds: [],
};

describe("SolanaManagedOrders", () => {
  it("shows exact cancel/reclaim amounts and reports the selected order", () => {
    let selected: SolanaManagedOrderPlan | null = null;
    let actionTrigger: HTMLButtonElement | null = null;
    const { container } = render(
      <SolanaManagedOrders
        orders={[cancelOrder, reclaimOrder, filledOrder]}
        onRequestAction={(order, trigger) => {
          selected = order;
          actionTrigger = trigger;
        }}
      />,
    );

    expect(container.textContent).toContain("Your orders");
    expect(container.textContent).toContain("Order #7");
    expect(container.textContent).toContain("1.5");
    expect(container.textContent).toContain("0.9 SOL");
    expect(container.textContent).toContain("0.00171912 SOL");
    expect(container.textContent).toContain("0.90171912 SOL");
    expect(container.textContent).toContain(
      "shared PriceLevel rent is excluded",
    );
    expect(container.textContent).toContain("Cancel order");
    expect(container.textContent).toContain("Reclaim resting order");
    expect(container.textContent).toContain("Recover filled-order rent");
    expect(container.textContent).toContain("Fully filled · rent ready");
    const reclaimAction = getByTestId(
      container,
      "solana-managed-order-action-9",
    ) as HTMLButtonElement;
    expect(reclaimAction.style.minHeight).toBe("44px");
    click(reclaimAction);
    expect((selected as SolanaManagedOrderPlan | null)?.orderId).toBe(9n);
    expect(actionTrigger as HTMLButtonElement | null).toBe(reclaimAction);
  });

  it("localizes action copy and blocks every action during submission", () => {
    const { container } = render(
      <SolanaManagedOrders
        orders={[cancelOrder, reclaimOrder, filledOrder]}
        submittingOrderId={7n}
        locale="zh"
        onRequestAction={() => undefined}
      />,
    );

    expect(container.textContent).toContain("你的订单");
    expect(container.textContent).toContain("处理中");
    expect(container.textContent).toContain("收回挂单");
    expect(container.textContent).toContain("取回已成交订单租金");
    expect(
      (
        getByTestId(
          container,
          "solana-managed-order-action-7",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        getByTestId(
          container,
          "solana-managed-order-action-10",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        getByTestId(
          container,
          "solana-managed-order-action-9",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("renders nothing when the wallet has no active orders", () => {
    const { container } = render(
      <SolanaManagedOrders orders={[]} onRequestAction={() => undefined} />,
    );
    expect(container.childElementCount).toBe(0);
  });
});
