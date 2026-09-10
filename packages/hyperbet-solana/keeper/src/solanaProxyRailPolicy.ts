export type SolanaProxySenderUpstream = {
  url: string;
  skipPreflight: boolean;
  maxRetries: number;
};

export type SolanaProxyRail = {
  rpcUrl: string | null;
  sender: SolanaProxySenderUpstream | null;
};

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.trim().toLowerCase(),
  );
}

function resolveProxyUrl(input: {
  value: string | null | undefined;
  label: string;
  required: boolean;
  localnet: boolean;
}): string | null {
  const value = input.value?.trim() ?? "";
  if (!value) {
    if (input.required) {
      throw new Error(`${input.label} is required on this deployment rail`);
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${input.label} must be an absolute HTTP(S) URL`);
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw new Error(
      `${input.label} must be an absolute HTTP(S) URL without credentials or a fragment`,
    );
  }
  if (
    url.protocol === "http:" &&
    (!input.localnet || !isLoopbackHostname(url.hostname))
  ) {
    throw new Error(
      `${input.label} must use HTTPS outside exact loopback localnet`,
    );
  }
  return url.toString();
}

export function resolveSolanaProxyRail(input: {
  deployment: boolean;
  cluster: string;
  rpcUrl: string | undefined;
  mainnetSenderUrl: string | null;
}): SolanaProxyRail {
  const cluster = input.cluster.trim().toLowerCase();
  const normalizedCluster = cluster === "mainnet" ? "mainnet-beta" : cluster;
  if (
    normalizedCluster !== "localnet" &&
    normalizedCluster !== "devnet" &&
    normalizedCluster !== "testnet" &&
    normalizedCluster !== "mainnet-beta"
  ) {
    throw new Error(`Unsupported Solana proxy cluster '${input.cluster}'`);
  }
  if (input.deployment && normalizedCluster === "localnet") {
    throw new Error("A deployed Solana proxy must not target localnet");
  }

  const localnet = normalizedCluster === "localnet";
  const rpcUrl = resolveProxyUrl({
    value: input.rpcUrl,
    label: "SOLANA_RPC_URL",
    required: input.deployment,
    localnet,
  });

  if (normalizedCluster === "mainnet-beta") {
    const senderUrl = resolveProxyUrl({
      value: input.mainnetSenderUrl,
      label: "Helius Sender URL",
      required: input.deployment,
      localnet: false,
    });
    return {
      rpcUrl,
      sender: senderUrl
        ? { url: senderUrl, skipPreflight: true, maxRetries: 0 }
        : null,
    };
  }

  return {
    rpcUrl,
    sender: rpcUrl
      ? { url: rpcUrl, skipPreflight: false, maxRetries: 5 }
      : null,
  };
}
