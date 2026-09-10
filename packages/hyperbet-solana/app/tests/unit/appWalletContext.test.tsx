import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TransactionWalletRoot } from "../../src/TransactionWalletRoot";
import {
  SpectatorAppWalletProvider,
  useAppConnection,
  useAppWallet,
  useAppWalletModal,
  type AppWallet,
  type AppWalletContextValue,
} from "../../src/lib/appWalletContext";

describe("spectator wallet boundary", () => {
  test("provides a complete inert wallet without loading transaction authority", async () => {
    let wallet: AppWallet | null = null;
    let modal: AppWalletContextValue["modal"] | null = null;

    function Observer() {
      wallet = useAppWallet();
      modal = useAppWalletModal();
      return null;
    }

    renderToStaticMarkup(
      <SpectatorAppWalletProvider>
        <Observer />
      </SpectatorAppWalletProvider>,
    );

    expect(wallet).not.toBeNull();
    expect(wallet!.address).toBeNull();
    expect(wallet!.publicKey).toBeNull();
    expect(wallet!.connected).toBeFalse();
    expect(wallet!.connecting).toBeFalse();
    expect(wallet!.wallets).toEqual([]);
    expect(modal).not.toBeNull();
    expect(modal!.visible).toBeFalse();

    await expect(wallet!.connect()).resolves.toBeUndefined();
    await expect(wallet!.disconnect()).resolves.toBeUndefined();
    expect(() => wallet!.select(null)).not.toThrow();
    expect(() => modal!.setVisible(true)).not.toThrow();
  });

  test("reuses one RPC connection for identical observer configuration", () => {
    const connections: unknown[] = [];

    function Observer() {
      connections.push(useAppConnection().connection);
      return null;
    }

    renderToStaticMarkup(<Observer />);
    renderToStaticMarkup(<Observer />);
    expect(connections).toHaveLength(2);
    expect(connections[0]).toBe(connections[1]);
  });

  test("binds the deferred transaction provider to the same app context", () => {
    let observedWallet: AppWallet | null = null;

    function Observer() {
      observedWallet = useAppWallet();
      return null;
    }

    renderToStaticMarkup(
      <TransactionWalletRoot>
        <Observer />
      </TransactionWalletRoot>,
    );

    expect(observedWallet).not.toBeNull();
    expect(observedWallet!.connected).toBeFalse();
    expect(observedWallet!.connecting).toBeFalse();
    expect(observedWallet!.session).toBeNull();
  });

  test("fails closed when wallet hooks render outside a provider", () => {
    function Observer() {
      useAppWallet();
      return null;
    }

    expect(() => renderToStaticMarkup(<Observer />)).toThrow(
      "useAppWallet must be used inside an app wallet provider.",
    );
  });
});
