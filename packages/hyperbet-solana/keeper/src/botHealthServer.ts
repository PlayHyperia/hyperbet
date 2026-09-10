import { timingSafeEqual } from "node:crypto";

import type { KeeperBotHealthSnapshot } from "./launchHealth";
import {
  evaluateKeeperBotReadiness,
  type KeeperBotReadinessResult,
} from "./readiness";
import type { KeeperReleaseIdentity } from "./releaseIdentity";
import type { KeeperRuntimeIdentity } from "./runtimeIdentity";

export interface DuelBotHealthServerConfig {
  port: number;
  bearerToken: string;
  maxAgeMs: number;
}

export function resolveDuelBotHealthServerConfig(input: {
  production: boolean;
  port?: string;
  bearerToken?: string;
  maxAgeMs?: string;
}): DuelBotHealthServerConfig {
  const port = Number(input.port ?? "8080");
  const maxAgeMs = Number(input.maxAgeMs ?? "30000");
  const bearerToken = input.bearerToken?.trim() ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BOT_HEALTH_PORT/PORT must be an integer from 1 to 65535");
  }
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 300_000) {
    throw new Error(
      "READINESS_BOT_MAX_AGE_MS must be an integer from 1000 to 300000",
    );
  }
  if (input.production && bearerToken.length < 32) {
    throw new Error(
      "KEEPER_BOT_HEALTH_BEARER_TOKEN must contain at least 32 characters in production",
    );
  }
  return { port, bearerToken, maxAgeMs };
}

export function evaluateDuelBotProcessReadiness(input: {
  nowMs: number;
  production: boolean;
  release: KeeperReleaseIdentity;
  runtime?: KeeperRuntimeIdentity;
  maxAgeMs: number;
  snapshot: KeeperBotHealthSnapshot | null;
}): KeeperBotReadinessResult {
  const result = evaluateKeeperBotReadiness({
    nowMs: input.nowMs,
    botMaxAgeMs: input.maxAgeMs,
    requireReleaseIdentity: input.production,
    expectedReleaseCommitSha: input.release.commitSha,
    expectedRuntimeIdentity: input.runtime,
    bot: input.snapshot,
  });
  const reasons = new Set(result.reasons);
  if (!input.runtime) {
    reasons.add("runtime-identity-unavailable");
  }
  if (input.production && input.release.commitSha == null) {
    reasons.add("release-identity-unavailable");
  } else if (input.production && input.release.source !== "manifest") {
    reasons.add("release-identity-not-baked");
  }
  return {
    ...result,
    ready: reasons.size === 0,
    reasons: [...reasons],
  };
}

function bearerTokenMatches(
  expectedToken: string,
  authorization: string,
): boolean {
  if (!expectedToken) return true;
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const actual = Buffer.from(authorization);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

export function startDuelBotHealthServer(input: {
  hostname?: string;
  config: DuelBotHealthServerConfig;
  production: boolean;
  release: KeeperReleaseIdentity;
  runtime?: KeeperRuntimeIdentity;
  getSnapshot: () => KeeperBotHealthSnapshot | null;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: input.hostname ?? "0.0.0.0",
    port: input.config.port,
    development: false,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/ready") {
        const readiness = evaluateDuelBotProcessReadiness({
          nowMs: Date.now(),
          production: input.production,
          release: input.release,
          runtime: input.runtime,
          maxAgeMs: input.config.maxAgeMs,
          snapshot: input.getSnapshot(),
        });
        return json(
          {
            ok: readiness.ready,
            service: "hyperbet-solana-duel-bot",
            release: input.release,
            runtime: input.runtime ?? null,
            readiness,
          },
          readiness.ready ? 200 : 503,
        );
      }
      if (request.method === "GET" && url.pathname === "/health/snapshot") {
        if (
          !bearerTokenMatches(
            input.config.bearerToken,
            request.headers.get("authorization") ?? "",
          )
        ) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
        const snapshot = input.getSnapshot();
        const readiness = evaluateDuelBotProcessReadiness({
          nowMs: Date.now(),
          production: input.production,
          release: input.release,
          runtime: input.runtime,
          maxAgeMs: input.config.maxAgeMs,
          snapshot,
        });
        return json(
          {
            ok: readiness.ready,
            service: "hyperbet-solana-duel-bot",
            release: input.release,
            runtime: input.runtime ?? null,
            readiness,
            health: snapshot,
          },
          readiness.ready ? 200 : 503,
        );
      }
      return json({ ok: false, error: "Not Found" }, 404);
    },
  });
}
