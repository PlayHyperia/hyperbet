export type DuelFeedConfig = {
  gameUrl: string;
  bearerToken: string;
};

export type StreamStateSourceConfig = {
  sourceUrl: string;
  bearerToken: string;
};

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.trim().toLowerCase(),
  );
}

export function resolveLocalDiagnosticDuelFeed(input: {
  requested: boolean;
  cluster: string;
  gameUrl: string;
  rpcUrl: string;
}): boolean {
  if (!input.requested) return false;
  if (input.cluster.trim().toLowerCase() !== "localnet") {
    throw new Error(
      "HYPERBET_LOCAL_DIAGNOSTIC_FEED requires SOLANA_CLUSTER=localnet",
    );
  }
  let gameUrl: URL;
  let rpcUrl: URL;
  try {
    gameUrl = new URL(input.gameUrl);
    rpcUrl = new URL(input.rpcUrl);
  } catch {
    throw new Error(
      "HYPERBET_LOCAL_DIAGNOSTIC_FEED requires absolute game and RPC URLs",
    );
  }
  for (const [label, parsed] of [
    ["GAME_URL", gameUrl],
    ["SOLANA_RPC_URL", rpcUrl],
  ] as const) {
    if (
      parsed.protocol !== "http:" ||
      !isLoopbackHostname(parsed.hostname) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(
        `HYPERBET_LOCAL_DIAGNOSTIC_FEED requires loopback HTTP ${label}`,
      );
    }
  }
  return true;
}

export function resolveDuelFeedConfig(input: {
  cluster: string;
  gameUrl: string;
  bearerToken?: string;
}): DuelFeedConfig {
  const gameUrl = input.gameUrl.trim().replace(/\/$/, "");
  const bearerToken = input.bearerToken?.trim() ?? "";

  let parsed: URL;
  try {
    parsed = new URL(gameUrl);
  } catch {
    throw new Error("GAME_URL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("GAME_URL must not contain embedded credentials");
  }
  const cluster = input.cluster.trim().toLowerCase();
  if (
    cluster !== "localnet" &&
    cluster !== "devnet" &&
    cluster !== "testnet" &&
    cluster !== "mainnet" &&
    cluster !== "mainnet-beta"
  ) {
    throw new Error(`Unsupported Solana duel-feed cluster '${input.cluster}'`);
  }
  if (cluster !== "localnet") {
    if (parsed.protocol !== "https:") {
      throw new Error("GAME_URL must use HTTPS on every non-local launch rail");
    }
    if (!bearerToken) {
      throw new Error(
        "BET_SYNC_SOURCE_BEARER_TOKEN is required on every non-local launch rail",
      );
    }
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("GAME_URL must use HTTP or HTTPS");
  }

  return { gameUrl, bearerToken };
}

export function resolveStreamStateSourceConfig(input: {
  production: boolean;
  sourceUrl?: string;
  bearerToken?: string;
}): StreamStateSourceConfig {
  const sourceUrl = input.sourceUrl?.trim() ?? "";
  const bearerToken = input.bearerToken?.trim() ?? "";

  if (!sourceUrl) {
    if (input.production) {
      throw new Error(
        "STREAM_STATE_SOURCE_URL is required in production and must target the canonical Hyperia /api/streaming/state endpoint",
      );
    }
    return { sourceUrl: "", bearerToken };
  }

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("STREAM_STATE_SOURCE_URL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "STREAM_STATE_SOURCE_URL must not contain embedded credentials",
    );
  }
  if (parsed.pathname !== "/api/streaming/state") {
    throw new Error(
      "STREAM_STATE_SOURCE_URL must target exactly /api/streaming/state",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "STREAM_STATE_SOURCE_URL must not include query parameters or a fragment",
    );
  }
  if (input.production) {
    if (parsed.protocol !== "https:") {
      throw new Error("STREAM_STATE_SOURCE_URL must use HTTPS in production");
    }
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("STREAM_STATE_SOURCE_URL must use HTTP or HTTPS");
  }

  return {
    sourceUrl: `${parsed.origin}${parsed.pathname}`,
    bearerToken,
  };
}

export function canAcceptStreamStatePublish(input: {
  production: boolean;
  sourceConfigured: boolean;
}): boolean {
  return !input.production && !input.sourceConfigured;
}
