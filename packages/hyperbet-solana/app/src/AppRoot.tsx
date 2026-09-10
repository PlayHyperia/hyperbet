import { Suspense, lazy } from "react";
import { Buffer } from "buffer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SpectatorAppWalletProvider } from "./lib/appWalletContext";
import { CONFIG } from "./lib/config";
import { App } from "./App";

const IS_STREAM_UI = import.meta.env.MODE === "stream-ui";
const StreamUIApp = lazy(() =>
  import("./StreamUIApp").then((module) => ({
    default: module.StreamUIApp,
  })),
);
const TransactionWalletRoot = lazy(() =>
  import("./TransactionWalletRoot").then((module) => ({
    default: module.TransactionWalletRoot,
  })),
);

if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const queryClient = new QueryClient();

function AppContent() {
  return IS_STREAM_UI ? (
    <Suspense fallback={<div className="app-root" aria-busy="true" />}>
      <StreamUIApp />
    </Suspense>
  ) : (
    <App />
  );
}

export default function AppRoot() {
  return (
    <QueryClientProvider client={queryClient}>
      {CONFIG.transactionsEnabled ? (
        <Suspense fallback={<div className="app-root" aria-busy="true" />}>
          <TransactionWalletRoot>
            <AppContent />
          </TransactionWalletRoot>
        </Suspense>
      ) : (
        <SpectatorAppWalletProvider>
          <AppContent />
        </SpectatorAppWalletProvider>
      )}
    </QueryClientProvider>
  );
}
