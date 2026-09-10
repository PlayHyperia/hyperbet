import { ed25519 } from "@noble/curves/ed25519.js";
import type { WalletConnector, WalletSession } from "@solana/client";
import type { Address } from "@solana/kit";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import { Buffer } from "buffer";

import bs58 from "bs58";

import { CONFIG } from "./config";

const DEFAULT_HEADLESS_WALLET_NAME = "Headless Test Wallet";
const HEADLESS_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' rx='8' fill='%230d58a6'/%3E%3Cpath d='M10 20h20M10 14h20M10 26h20' stroke='white' stroke-width='2'/%3E%3C/svg%3E";
const E2E_REJECT_NEXT_SIGNATURE_KEY =
  "hyperbet.e2e.reject-next-wallet-signature";

export const LOCAL_E2E_WALLET_APPROVAL = Object.freeze({
  requests: "hyperbet.e2e.wallet-signature-requests",
  pauseNext: "hyperbet.e2e.pause-next-wallet-signature",
  pending: "hyperbet.e2e.pending-wallet-signature",
  releaseEvent: "hyperbet:e2e:release-wallet-signature",
  cancelEvent: "hyperbet:e2e:cancel-wallet-signature",
});

// This is the local test wallet's approval UI boundary, not a production
// wallet bypass. Expiration rejects; only an explicit matching release signs.
export async function requestLocalE2eWalletSignatureApproval(input: {
  mode: string;
  hostname: string | null;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  events: EventTarget;
  timeoutMs?: number;
}): Promise<void> {
  if (!isHeadlessWalletRuntimeAllowed(input)) return;
  const timeoutMs = input.timeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Local E2E wallet approval deadline is invalid");
  }
  const keys = LOCAL_E2E_WALLET_APPROVAL;
  const rawCount = input.storage.getItem(keys.requests) ?? "0";
  const previousCount = Number(rawCount);
  if (
    !/^(0|[1-9][0-9]*)$/.test(rawCount) ||
    !Number.isSafeInteger(previousCount) ||
    previousCount >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Local E2E wallet request counter is invalid");
  }
  const requestId = String(previousCount + 1);
  input.storage.setItem(keys.requests, requestId);
  if (input.storage.getItem(keys.pending) !== null) {
    throw new Error("Local E2E wallet already has a pending approval");
  }
  if (input.storage.getItem(keys.pauseNext) !== "1") return;
  input.storage.removeItem(keys.pauseNext);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      input.events.removeEventListener(keys.releaseEvent, release);
      input.events.removeEventListener(keys.cancelEvent, cancel);
      input.storage.removeItem(keys.pending);
    };
    const release = (event: Event) => {
      if (!("detail" in event) || event.detail !== requestId) return;
      cleanup();
      resolve();
    };
    const cancel = (event: Event) => {
      if (!("detail" in event) || event.detail !== requestId) return;
      cleanup();
      reject(new Error("Local E2E wallet approval cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Local E2E wallet approval timed out"));
    }, timeoutMs);
    input.events.addEventListener(keys.releaseEvent, release);
    input.events.addEventListener(keys.cancelEvent, cancel);
    input.storage.setItem(keys.pending, requestId);
  });
}

type HeadlessWalletEntry = {
  name?: string;
  secretKey: string;
  autoConnect?: boolean;
};

export function isHeadlessWalletRuntimeAllowed(input: {
  mode: string;
  hostname: string | null;
}): boolean {
  if (input.mode !== "e2e" || input.hostname === null) return false;
  const hostname = input.hostname.trim().toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isLocalE2eWalletRuntime(): boolean {
  return isHeadlessWalletRuntimeAllowed({
    mode: import.meta.env.MODE,
    hostname: typeof window === "undefined" ? null : window.location.hostname,
  });
}

export type HeadlessWalletDescriptor = {
  autoConnect: boolean;
  connector: WalletConnector;
};

function validateSecretKeyBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error(
      `Headless wallet secret key must be 32 or 64 bytes (received ${bytes.length})`,
    );
  }
  return bytes;
}

function keypairFromSecret(secretKey: Uint8Array): Keypair {
  return secretKey.length === 32
    ? Keypair.fromSeed(secretKey)
    : Keypair.fromSecretKey(secretKey);
}

function shouldRejectNextE2eSignature(): boolean {
  if (!isLocalE2eWalletRuntime()) {
    return false;
  }
  if (window.sessionStorage.getItem(E2E_REJECT_NEXT_SIGNATURE_KEY) !== "1") {
    return false;
  }
  window.sessionStorage.removeItem(E2E_REJECT_NEXT_SIGNATURE_KEY);
  return true;
}

function parseSecretKey(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error("Headless wallet secret key is empty");
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 255,
      )
    ) {
      throw new Error("Invalid JSON byte array secret key");
    }
    return validateSecretKeyBytes(Uint8Array.from(parsed));
  }

  if (trimmed.includes(",")) {
    const values = trimmed.split(",").map((value) => Number(value.trim()));
    if (
      values.length === 0 ||
      !values.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 255,
      )
    ) {
      throw new Error("Invalid comma-separated byte secret key");
    }
    return validateSecretKeyBytes(Uint8Array.from(values));
  }

  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 32 || decoded.length === 64) {
      return validateSecretKeyBytes(decoded);
    }
  } catch {
    // Continue to other formats.
  }

  try {
    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
      const decoded = Uint8Array.from(Buffer.from(trimmed, "base64"));
      if (decoded.length === 32 || decoded.length === 64) {
        return validateSecretKeyBytes(decoded);
      }
    }
  } catch {
    // Continue to error.
  }

  throw new Error(
    "Unsupported secret key format (expected JSON array, comma-separated bytes, bs58, or base64)",
  );
}

function parseHeadlessWalletEntries(): HeadlessWalletEntry[] {
  if (!isLocalE2eWalletRuntime()) return [];
  const fromJson = CONFIG.headlessWalletsJson.trim();
  if (!fromJson) {
    const legacySecret = CONFIG.headlessWalletSecretKey.trim();
    if (!legacySecret) return [];
    return [
      {
        name: getHeadlessWalletName(),
        secretKey: legacySecret,
        autoConnect: CONFIG.headlessWalletAutoConnect,
      },
    ];
  }

  try {
    const parsed = JSON.parse(fromJson) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("VITE_HEADLESS_WALLETS must be a JSON array");
    }

    return parsed
      .map((value, index) => {
        if (typeof value === "string") {
          return {
            name: `${DEFAULT_HEADLESS_WALLET_NAME} ${index + 1}`,
            secretKey: value,
            autoConnect: index === 0 && CONFIG.headlessWalletAutoConnect,
          };
        }

        if (value && typeof value === "object") {
          const candidate = value as Partial<HeadlessWalletEntry>;
          return {
            name:
              typeof candidate.name === "string" ? candidate.name : undefined,
            secretKey:
              typeof candidate.secretKey === "string"
                ? candidate.secretKey
                : "",
            autoConnect:
              typeof candidate.autoConnect === "boolean"
                ? candidate.autoConnect
                : false,
          };
        }

        return {
          name: undefined,
          secretKey: "",
          autoConnect: false,
        };
      })
      .filter((entry) => entry.secretKey.trim().length > 0);
  } catch (error) {
    console.error(
      "[headless-wallet] Failed to parse VITE_HEADLESS_WALLETS:",
      (error as Error).message,
    );
    return [];
  }
}

function createHeadlessSession(
  connectorId: string,
  connectorName: string,
  keypair: Keypair,
  onDisconnect: () => Promise<void>,
): WalletSession {
  return {
    account: {
      address: keypair.publicKey.toBase58() as Address,
      label: connectorName,
      publicKey: keypair.publicKey.toBytes(),
    },
    connector: {
      canAutoConnect: true,
      icon: HEADLESS_ICON,
      id: connectorId,
      kind: "headless",
      name: connectorName,
      ready: true,
    },
    disconnect: onDisconnect,
    signMessage: async (message: Uint8Array) =>
      ed25519.sign(message, keypair.secretKey.slice(0, 32)),
    signTransaction: async (transaction) => {
      await requestLocalE2eWalletSignatureApproval({
        mode: import.meta.env.MODE,
        hostname:
          typeof window === "undefined" ? null : window.location.hostname,
        storage: window.sessionStorage,
        events: window,
      });
      if (shouldRejectNextE2eSignature()) {
        throw new Error("User rejected the request");
      }
      const web3Transaction = transaction as unknown as
        Transaction | VersionedTransaction;
      if ("version" in web3Transaction) {
        web3Transaction.sign([keypair]);
      } else {
        web3Transaction.partialSign(keypair);
      }
      return transaction;
    },
  };
}

function createHeadlessConnector(
  secretKey: Uint8Array,
  name: string,
  index: number,
): WalletConnector {
  const fixedKeypair = keypairFromSecret(secretKey);
  let activeSession: WalletSession | null = null;
  const id = `headless:${index}:${fixedKeypair.publicKey.toBase58()}`;

  const disconnect = async () => {
    activeSession = null;
  };

  return {
    canAutoConnect: true,
    connect: async () => {
      activeSession =
        activeSession ??
        createHeadlessSession(
          id,
          name,
          Keypair.fromSecretKey(fixedKeypair.secretKey),
          disconnect,
        );
      return activeSession;
    },
    disconnect,
    icon: HEADLESS_ICON,
    id,
    isSupported: () => true,
    kind: "headless",
    name,
    ready: true,
  };
}

function getHeadlessWalletName(): string {
  return CONFIG.headlessWalletName || DEFAULT_HEADLESS_WALLET_NAME;
}

export function isHeadlessWalletEnabled(): boolean {
  return parseHeadlessWalletEntries().length > 0;
}

export function shouldAutoConnectHeadlessWallet(): boolean {
  return parseHeadlessWalletEntries().some((entry) =>
    Boolean(entry.autoConnect),
  );
}

export function createHeadlessWalletConnectorsFromEnv(): HeadlessWalletDescriptor[] {
  const entries = parseHeadlessWalletEntries();
  if (entries.length === 0) return [];

  return entries
    .map((entry, index) => {
      try {
        const secret = parseSecretKey(entry.secretKey);
        const name =
          entry.name?.trim() || `${DEFAULT_HEADLESS_WALLET_NAME} ${index + 1}`;
        return {
          autoConnect: Boolean(entry.autoConnect),
          connector: createHeadlessConnector(secret, name, index),
        } as HeadlessWalletDescriptor;
      } catch (error) {
        console.error(
          `[headless-wallet] Failed to load wallet #${index + 1}:`,
          (error as Error).message,
        );
        return null;
      }
    })
    .filter((entry): entry is HeadlessWalletDescriptor => entry !== null);
}
