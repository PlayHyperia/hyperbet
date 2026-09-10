import type { KeeperBotHealthSnapshot } from "./launchHealth";
import { parseKeeperBotHealthSnapshot } from "./readiness";

export interface KeeperBotHealthSourceConfig {
  sourceUrl: string;
  bearerToken: string;
  timeoutMs: number;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

export function resolveKeeperBotHealthSourceConfig(input: {
  production: boolean;
  sourceUrl?: string;
  bearerToken?: string;
  timeoutMs?: number;
}): KeeperBotHealthSourceConfig | null {
  const sourceUrl = input.sourceUrl?.trim() ?? "";
  const bearerToken = input.bearerToken?.trim() ?? "";
  const timeoutMs = input.timeoutMs ?? 3_000;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error(
      "KEEPER_BOT_HEALTH_TIMEOUT_MS must be an integer from 250 to 30000",
    );
  }
  if (!sourceUrl) {
    if (input.production) {
      throw new Error(
        "KEEPER_BOT_HEALTH_URL is required in production for the dedicated duel-bot service",
      );
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("KEEPER_BOT_HEALTH_URL must be an absolute URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "KEEPER_BOT_HEALTH_URL must not contain embedded credentials",
    );
  }
  if (parsed.pathname !== "/health/snapshot" || parsed.search || parsed.hash) {
    throw new Error(
      "KEEPER_BOT_HEALTH_URL must target exactly /health/snapshot without a query or fragment",
    );
  }

  const isPrivateRailwayHost = parsed.hostname.endsWith(".railway.internal");
  const isLoopback = isLoopbackHostname(parsed.hostname);
  if (input.production) {
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isPrivateRailwayHost)
    ) {
      throw new Error(
        "production KEEPER_BOT_HEALTH_URL must use HTTPS or Railway private HTTP",
      );
    }
    if (bearerToken.length < 32) {
      throw new Error(
        "KEEPER_BOT_HEALTH_BEARER_TOKEN must contain at least 32 characters in production",
      );
    }
  } else if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && (isLoopback || isPrivateRailwayHost))
  ) {
    throw new Error(
      "local KEEPER_BOT_HEALTH_URL must use HTTPS, loopback HTTP, or Railway private HTTP",
    );
  }

  return {
    sourceUrl: `${parsed.origin}${parsed.pathname}`,
    bearerToken,
    timeoutMs,
  };
}

export async function fetchKeeperBotHealthSnapshot(
  config: KeeperBotHealthSourceConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<KeeperBotHealthSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImplementation(config.sourceUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: config.bearerToken
        ? { authorization: `Bearer ${config.bearerToken}` }
        : undefined,
    });
    if (!response.ok && response.status !== 503) {
      throw new Error(
        `duel-bot health request returned HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as unknown;
    const health =
      body && typeof body === "object"
        ? (body as { health?: unknown }).health
        : null;
    const snapshot = parseKeeperBotHealthSnapshot(health);
    if (!snapshot) {
      throw new Error("duel-bot health response contained an invalid snapshot");
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}
