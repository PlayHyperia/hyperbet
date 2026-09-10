import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WalletSelectionModal } from "../../src/components/WalletSelectionModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.style.overflow = "";
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function renderModal(state: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WalletSelectionModal state={state as never} />);
    await new Promise((resolve) => window.setTimeout(resolve, 1));
  });
}

describe("wallet selection modal", () => {
  test("is modal, traps transaction context, and explains connection failure", async () => {
    const close = mock(() => undefined);
    const connect = mock(async () => {
      throw new Error("extension detail must not leak");
    });
    await renderModal({
      isOpen: true,
      close,
      connect,
      connecting: false,
      connectors: [
        { id: "ready", name: "Ready Wallet", ready: true },
        { id: "unavailable", name: "Unavailable Wallet", ready: false },
      ],
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".wallet-button"),
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);

    await act(async () => {
      buttons[0].click();
      await Promise.resolve();
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "did not complete",
    );

    act(() => {
      dialog?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("reports an empty supported-wallet set", async () => {
    await renderModal({
      isOpen: true,
      close: mock(() => undefined),
      connect: mock(async () => undefined),
      connecting: false,
      connectors: [],
    });

    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "No compatible Solana wallet",
    );
  });
});
