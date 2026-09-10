import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { WalletSession } from "@solana/client";
import type { Address } from "@solana/kit";
import {
  Connection,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";

import { getRpcUrl, getWsUrl } from "./config";

type WalletLike = {
  id: string;
  name: string;
  icon?: string;
  ready: boolean;
};

export type AppWallet = {
  address: Address | null;
  connect: () => Promise<void>;
  connected: boolean;
  connecting: boolean;
  disconnect: () => Promise<void>;
  publicKey: PublicKey | null;
  session: WalletSession | null;
  select: (connectorId: string | null) => void;
  signAllTransactions?: <T extends Array<Transaction | VersionedTransaction>>(
    txs: T,
  ) => Promise<T>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction?: <T extends Transaction | VersionedTransaction>(
    tx: T,
  ) => Promise<T>;
  wallet: WalletLike | null;
  wallets: WalletLike[];
};

export type AppWalletContextValue = {
  modal: {
    setVisible: (visible: boolean) => void;
    visible: boolean;
  };
  wallet: AppWallet;
};

export const AppWalletContext = createContext<AppWalletContextValue | null>(
  null,
);

const spectatorWallet: AppWallet = {
  address: null,
  connect: async () => {},
  connected: false,
  connecting: false,
  disconnect: async () => {},
  publicKey: null,
  session: null,
  select: () => {},
  signAllTransactions: undefined,
  signMessage: undefined,
  signTransaction: undefined,
  wallet: null,
  wallets: [],
};

const spectatorContext: AppWalletContextValue = {
  modal: {
    setVisible: () => {},
    visible: false,
  },
  wallet: spectatorWallet,
};

const connectionCache = new Map<string, Connection>();

function getSharedConnection(rpcUrl: string, wsUrl: string): Connection {
  const cacheKey = `${rpcUrl}|${wsUrl}`;
  const cached = connectionCache.get(cacheKey);
  if (cached) return cached;

  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    wsEndpoint: wsUrl,
  });
  connectionCache.set(cacheKey, connection);
  return connection;
}

export function SpectatorAppWalletProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <AppWalletContext.Provider value={spectatorContext}>
      {children}
    </AppWalletContext.Provider>
  );
}

export function useAppConnection(): { connection: Connection } {
  const rpcUrl = getRpcUrl();
  const wsUrl = getWsUrl() ?? rpcUrl.replace(/^http/i, "ws");
  return useMemo(
    () => ({ connection: getSharedConnection(rpcUrl, wsUrl) }),
    [rpcUrl, wsUrl],
  );
}

export function useAppWallet(): AppWallet {
  const context = useContext(AppWalletContext);
  if (!context) {
    throw new Error("useAppWallet must be used inside an app wallet provider.");
  }
  return context.wallet;
}

export function useAppWalletModal(): AppWalletContextValue["modal"] {
  const context = useContext(AppWalletContext);
  if (!context) {
    throw new Error(
      "useAppWalletModal must be used inside an app wallet provider.",
    );
  }
  return context.modal;
}
