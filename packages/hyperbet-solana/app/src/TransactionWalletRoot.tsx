import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SolanaProvider } from "@solana/react-hooks";
import { watchWalletStandardConnectors } from "@solana/client";

import { AppWalletProvider } from "./lib/appWallet";
import { createFrameworkClient } from "./lib/frameworkClient";
import { createHeadlessWalletConnectorsFromEnv } from "./lib/headlessWallet";

export function TransactionWalletRoot({ children }: { children: ReactNode }) {
  const [walletScanVersion, setWalletScanVersion] = useState(0);
  const headlessWallets = useMemo(
    () => createHeadlessWalletConnectorsFromEnv(),
    [],
  );
  const frameworkClient = useMemo(
    () => createFrameworkClient(),
    [walletScanVersion],
  );
  const frameworkClientRef = useRef(frameworkClient);
  frameworkClientRef.current = frameworkClient;
  const knownConnectorIdsRef = useRef<string>("");
  const autoConnectHeadlessConnectorId =
    headlessWallets.find((entry) => entry.autoConnect)?.connector.id ?? null;

  useEffect(() => {
    const stopWatchingWallets = watchWalletStandardConnectors((connectors) => {
      const nextConnectorIds = connectors
        .map((connector) => connector.id)
        .sort()
        .join("|");
      if (nextConnectorIds === knownConnectorIdsRef.current) return;
      knownConnectorIdsRef.current = nextConnectorIds;

      const walletStatus = frameworkClient.store.getState().wallet.status;
      if (walletStatus === "disconnected") {
        setWalletScanVersion((value) => value + 1);
      }
    });

    return stopWatchingWallets;
  }, [frameworkClient]);

  useEffect(() => {
    const delayedRescanId = window.setTimeout(() => {
      const walletStatus =
        frameworkClientRef.current.store.getState().wallet.status;
      if (walletStatus === "disconnected") {
        setWalletScanVersion((value) => value + 1);
      }
    }, 500);

    return () => window.clearTimeout(delayedRescanId);
  }, []);

  return (
    <SolanaProvider
      client={frameworkClient}
      walletPersistence={{
        autoConnect: true,
        storageKey: "hyperbet-solana:last-wallet",
      }}
    >
      <AppWalletProvider
        headlessAutoConnectorId={autoConnectHeadlessConnectorId}
      >
        {children}
      </AppWalletProvider>
    </SolanaProvider>
  );
}
