import { useEffect, useMemo, type ReactNode } from "react";
import { useWalletConnection, useWalletModalState } from "@solana/react-hooks";
import type { WalletConnector, WalletSession } from "@solana/client";
import { type Transaction, type VersionedTransaction } from "@solana/web3.js";

import { WalletSelectionModal } from "../components/WalletSelectionModal";
import { deriveSolanaWalletSessionIdentity } from "./walletIdentity";
import {
  AppWalletContext,
  type AppWallet,
  type AppWalletContextValue,
} from "./appWalletContext";

export type { AppWallet } from "./appWalletContext";

function walletReady(connector: WalletConnector): boolean {
  return connector.ready !== false;
}

function createAppWallet(
  connectionState: ReturnType<typeof useWalletConnection>,
  modalState: ReturnType<typeof useWalletModalState>,
): AppWallet {
  const session = connectionState.wallet ?? null;
  const identity = session
    ? deriveSolanaWalletSessionIdentity({
        address: session.account.address,
        publicKey: session.account.publicKey,
      })
    : null;
  const verifiedSession = identity ? session : null;
  const wallets = connectionState.connectors.map((connector) => ({
    id: connector.id,
    name: connector.name,
    icon: connector.icon,
    ready: walletReady(connector),
  }));
  const activeWallet = connectionState.currentConnector
    ? {
        id: connectionState.currentConnector.id,
        name: connectionState.currentConnector.name,
        icon: connectionState.currentConnector.icon,
        ready: walletReady(connectionState.currentConnector),
      }
    : null;

  const signTransaction = verifiedSession?.signTransaction
    ? async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> =>
        (await verifiedSession.signTransaction!(
          tx as unknown as Parameters<
            NonNullable<WalletSession["signTransaction"]>
          >[0],
        )) as unknown as T
    : undefined;

  const signAllTransactions = signTransaction
    ? async <T extends Array<Transaction | VersionedTransaction>>(
        txs: T,
      ): Promise<T> => {
        const signed: Array<Transaction | VersionedTransaction> = [];
        for (const tx of txs) {
          signed.push(await signTransaction(tx));
        }
        return signed as T;
      }
    : undefined;

  const signMessage = verifiedSession?.signMessage
    ? async (message: Uint8Array): Promise<Uint8Array> =>
        await verifiedSession.signMessage!(message)
    : undefined;

  return {
    address: identity?.address ?? null,
    connect: async () => {
      if (connectionState.connectorId) {
        await connectionState.connect(connectionState.connectorId);
        return;
      }
      modalState.open();
    },
    connected: connectionState.connected && identity !== null,
    connecting: connectionState.connecting,
    disconnect: async () => {
      await connectionState.disconnect();
    },
    publicKey: identity?.publicKey ?? null,
    session: verifiedSession,
    select: (connectorId) => modalState.select(connectorId),
    signAllTransactions,
    signMessage,
    signTransaction,
    wallet: activeWallet,
    wallets,
  };
}

export function AppWalletProvider({
  children,
  headlessAutoConnectorId,
}: {
  children: ReactNode;
  headlessAutoConnectorId: string | null;
}) {
  const connectionState = useWalletConnection();
  const modalState = useWalletModalState();

  useEffect(() => {
    if (!headlessAutoConnectorId) return;
    if (connectionState.connected || connectionState.connecting) return;
    const connector = connectionState.connectors.find(
      (entry) => entry.id === headlessAutoConnectorId,
    );
    if (!connector || !walletReady(connector)) return;
    void connectionState
      .connect(headlessAutoConnectorId, {
        allowInteractiveFallback: false,
        autoConnect: true,
      })
      .catch(() => undefined);
  }, [
    connectionState.connected,
    connectionState.connect,
    connectionState.connecting,
    connectionState.connectors,
    headlessAutoConnectorId,
  ]);

  const value = useMemo<AppWalletContextValue>(
    () => ({
      modal: {
        setVisible: (visible) => {
          if (visible) {
            modalState.open();
          } else {
            modalState.close();
          }
        },
        visible: modalState.isOpen,
      },
      wallet: createAppWallet(connectionState, modalState),
    }),
    [connectionState, modalState],
  );

  return (
    <AppWalletContext.Provider value={value}>
      {children}
      <WalletSelectionModal state={modalState} />
    </AppWalletContext.Provider>
  );
}
