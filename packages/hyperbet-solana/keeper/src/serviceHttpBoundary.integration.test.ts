import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { PublicKey } from "@solana/web3.js";

import {
  buildSolanaWalletActionMessage,
  type SolanaWalletAction,
} from "./solanaWalletActionProof";
import {
  extractStreamStateSourceEvents,
  type ParsedStreamStateSourceEvent,
} from "./streamStateSourceSse";

const ownedChildren = new Set<ReturnType<typeof Bun.spawn>>();
const ownedServers = new Set<ReturnType<typeof Bun.serve>>();
const ownedDirectories = new Set<string>();

function createWalletProofSigner() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({
    format: "der",
    type: "spki",
  });
  const wallet = new PublicKey(publicKeyDer.subarray(-32)).toBase58();
  return {
    wallet,
    proof(action: SolanaWalletAction, inviteCode: string | null) {
      const issuedAtMs = Date.now();
      const message = buildSolanaWalletActionMessage({
        action,
        cluster: "localnet",
        wallet,
        inviteCode,
        issuedAtMs,
      });
      return {
        issuedAtMs,
        signature: signEd25519(
          null,
          Buffer.from(message),
          keyPair.privateKey,
        ).toString("base64"),
      };
    },
  };
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve an isolated test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForService(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`service did not become available: ${String(lastError)}`);
}

afterEach(async () => {
  for (const child of ownedChildren) {
    child.kill("SIGTERM");
    await child.exited;
  }
  ownedChildren.clear();
  for (const server of ownedServers) server.stop(true);
  ownedServers.clear();
  for (const directory of ownedDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  ownedDirectories.clear();
});

describe("keeper service HTTP boundary", () => {
  test("promotes accepted public SSE to REST without replaying current authority or accepting a stale poll", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hyperbet-stream-rest-"));
    ownedDirectories.add(directory);
    const sourcePort = await reservePort();
    const servicePort = await reservePort();
    const streamStateFile = path.join(directory, "stream-state.json");
    const sourceControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const sourceRequests: Array<{
      pathname: string;
      authorization: string | null;
    }> = [];
    const encoder = new TextEncoder();
    let timestamp = 0;
    const frame = (seq: number, cycleId: string, ready: boolean) => {
      timestamp = Math.max(Date.now(), timestamp + 1);
      return {
        type: "STREAMING_STATE_UPDATE",
        seq,
        emittedAt: timestamp,
        cycle: {
          cycleId,
          duelId: `streaming-${cycleId}`,
          phase: "ANNOUNCEMENT",
          rendererHealth: {
            ready,
            degradedReason: ready ? null : "capture_process_exited",
            updatedAt: timestamp,
          },
        },
        leaderboard: [],
        cameraTarget: null,
        preparation: null,
      };
    };
    type SourceFrame = ReturnType<typeof frame>;
    let baseline: SourceFrame | null = null;
    let heldRestRequests = 0;
    let releaseRest = () => {};
    let restCandidate: SourceFrame | null = null;
    let restGate = Promise.resolve();
    const holdRest = (candidate: SourceFrame | null) => {
      restCandidate = candidate;
      restGate = new Promise<void>((resolve) => {
        releaseRest = resolve;
      });
    };
    holdRest(null);
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: sourcePort,
      async fetch(request) {
        const url = new URL(request.url);
        sourceRequests.push({
          pathname: url.pathname,
          authorization: request.headers.get("authorization"),
        });
        if (url.pathname === "/api/streaming/state") {
          if (!baseline) {
            baseline = frame(100, "cycle-a", true);
            return Response.json(baseline);
          }
          const staleResponse = restCandidate ?? baseline;
          heldRestRequests += 1;
          await restGate;
          return Response.json(staleResponse);
        }
        if (url.pathname === "/api/streaming/state/events") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                sourceControllers.push(controller);
                controller.enqueue(encoder.encode(": connected\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    ownedServers.add(source);
    const child = Bun.spawn([process.execPath, "--bun", "src/service.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        NODE_ENV: "development",
        HYPERBET_RUNTIME_ROLE: "service",
        PORT: String(servicePort),
        SOLANA_CLUSTER: "localnet",
        SOLANA_RPC_URL: "http://127.0.0.1:1",
        KEEPER_DB_PATH: path.join(directory, "keeper.sqlite"),
        KEEPER_BOT_HEALTH_FILE: path.join(directory, "bot-health.json"),
        KEEPER_STREAM_STATE_FILE: streamStateFile,
        HYPERBET_OPERATOR_ALERT_STATE_FILE: path.join(
          directory,
          "operator-alert-state.json",
        ),
        STREAM_STATE_SOURCE_URL: `http://127.0.0.1:${sourcePort}/api/streaming/state`,
        STREAM_STATE_SOURCE_EVENTS_ENABLED: "true",
        STREAM_STATE_SOURCE_EVENTS_RECONNECT_MS: "500",
        STREAM_STATE_SOURCE_TIMEOUT_MS: "20000",
        STREAM_STATE_POLL_MS: "1000",
        CONTRACT_POLL_MS: "60000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    ownedChildren.add(child);
    const baseUrl = `http://127.0.0.1:${servicePort}`;
    const waitUntil = async (
      label: string,
      check: () => boolean | Promise<boolean>,
    ) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(25);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const readPublic = async () => {
      const response = await fetch(`${baseUrl}/api/streaming/state`, {
        signal: AbortSignal.timeout(1_000),
      });
      return {
        status: response.status,
        state: (await response.json()) as SourceFrame,
      };
    };
    const readStatus = async () =>
      (await (
        await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1_000) })
      ).json()) as {
        readiness: { reasons: string[] };
        stream: {
          seq: number;
          lastSourcePollAt: number;
          lastSourceError: string | null;
          sourceAvailable: boolean;
        };
      };
    const emit = (event: "state" | "reset", value: SourceFrame) => {
      const controller = sourceControllers.at(-1);
      if (!controller) throw new Error("Owned upstream SSE is not connected");
      controller.enqueue(
        encoder.encode(
          `id: ${value.seq}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
        ),
      );
    };
    const viewers: Array<{
      reader: ReadableStreamDefaultReader<Uint8Array>;
      finished: Promise<void>;
    }> = [];
    const openViewer = async () => {
      const response = await fetch(`${baseUrl}/api/streaming/state/events`);
      expect(response.status).toBe(200);
      if (!response.body) throw new Error("Public SSE body is missing");
      const reader = response.body.getReader();
      const events: ParsedStreamStateSourceEvent[] = [];
      const finished = (async () => {
        const decoder = new TextDecoder();
        let buffered = "";
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          buffered += decoder.decode(next.value, { stream: true });
          const parsed = extractStreamStateSourceEvents(buffered);
          buffered = parsed.remainder;
          events.push(...parsed.events);
        }
      })();
      viewers.push({ reader, finished });
      return events;
    };
    try {
      await waitForService(baseUrl);
      await waitUntil(
        "the initial REST snapshot",
        async () => (await readPublic()).state.seq === 100,
      );
      await waitUntil(
        "an in-flight stale source poll and live SSE",
        () => heldRestRequests > 0 && sourceControllers.length === 1,
      );
      const persistedBaseline = readFileSync(streamStateFile, "utf8");
      const events = await openViewer();
      await waitUntil("the initial subscriber reset", () =>
        events.some((event) => event.event === "reset" && event.id === 100),
      );

      const unavailable = frame(101, "cycle-a", false);
      emit("state", unavailable);
      await waitUntil("the unavailable public timeline", () =>
        events.some((event) => event.event === "timeline" && event.id === 101),
      );
      await waitUntil(
        "SSE authority in REST before the stale poll is released",
        async () => (await readPublic()).state.seq === 101,
      );
      expect(await readPublic()).toEqual({ status: 200, state: unavailable });
      expect(readFileSync(streamStateFile, "utf8")).toBe(persistedBaseline);
      const resetEvents = await openViewer();
      await waitUntil("a fresh subscriber reset", () =>
        resetEvents.some(
          (event) => event.event === "reset" && event.id === 101,
        ),
      );
      expect(JSON.parse(resetEvents[0].data)).toEqual(unavailable);

      const releasedAt = Date.now();
      releaseRest();
      await waitUntil(
        "completion of the superseded in-flight poll",
        async () => {
          const status = await readStatus();
          return status.stream.lastSourcePollAt >= releasedAt;
        },
      );
      expect((await readStatus()).stream.lastSourceError).toBeNull();
      expect((await readStatus()).readiness.reasons).not.toContain(
        "stream-source-error",
      );
      expect(await readPublic()).toEqual({ status: 200, state: unavailable });

      const priorMalformedRequestCount = heldRestRequests;
      holdRest(frame(-1, "cycle-a", false));
      await waitUntil(
        "an in-flight malformed candidate",
        () => heldRestRequests > priorMalformedRequestCount,
      );
      const laterPublicState = frame(102, "cycle-a", false);
      emit("state", laterPublicState);
      await waitUntil(
        "public SSE superseding a malformed candidate",
        async () => (await readPublic()).state.seq === 102,
      );
      const malformedReleasedAt = Date.now();
      releaseRest();
      await waitUntil(
        "a malformed poll remaining fail closed despite newer SSE",
        async () => {
          const status = await readStatus();
          return (
            status.stream.lastSourcePollAt >= malformedReleasedAt &&
            status.stream.lastSourceError ===
              "Awaiting authoritative stream frame"
          );
        },
      );
      expect((await readStatus()).readiness.reasons).toContain(
        "stream-source-error",
      );
      expect(await readPublic()).toEqual({
        status: 200,
        state: laterPublicState,
      });

      const rollover = frame(103, "cycle-b", false);
      emit("state", rollover);
      await waitUntil(
        "the next public cycle",
        async () => (await readPublic()).state.seq === 103,
      );
      expect(await readPublic()).toEqual({ status: 200, state: rollover });
      const priorHeartbeatCount = events.filter(
        (event) => event.event === "timeline" && event.id === 103,
      ).length;
      emit("reset", rollover);
      await waitUntil(
        "an identical canonical heartbeat",
        () =>
          events.filter(
            (event) => event.event === "timeline" && event.id === 103,
          ).length > priorHeartbeatCount,
      );
      expect(await readPublic()).toEqual({ status: 200, state: rollover });

      sourceControllers[0].close();
      await waitUntil(
        "an explicit unavailable edge",
        async () => (await readPublic()).status === 503,
      );
      await waitUntil(
        "the reconnected upstream",
        () => sourceControllers.length === 2,
      );
      emit("reset", { ...rollover, seq: 1 });
      await waitUntil(
        "the rejected stale reset",
        async () =>
          (await readStatus()).stream.lastSourceError ===
          "Awaiting authoritative stream frame",
      );
      expect((await readPublic()).status).toBe(503);
      const restarted = frame(1, "cycle-b", false);
      emit("reset", restarted);
      await waitUntil(
        "a strictly newer restarted authority",
        async () => (await readPublic()).status === 200,
      );
      expect(await readPublic()).toEqual({ status: 200, state: restarted });
      const priorEpochRequestCount = heldRestRequests;
      holdRest(baseline);
      await waitUntil(
        "an in-flight prior-epoch candidate",
        () => heldRestRequests > priorEpochRequestCount,
      );
      const currentEpoch = frame(2, "cycle-b", false);
      emit("state", currentEpoch);
      await waitUntil(
        "current-epoch SSE superseding a prior-epoch poll",
        async () => (await readPublic()).state.seq === 2,
      );
      const resetAt = Date.now();
      releaseRest();
      await waitUntil("rejection of the prior-epoch REST cursor", async () => {
        const status = await readStatus();
        return (
          status.stream.lastSourcePollAt >= resetAt &&
          status.stream.lastSourceError ===
            "Awaiting authoritative stream frame"
        );
      });
      expect((await readStatus()).readiness.reasons).toContain(
        "stream-source-error",
      );
      expect(await readPublic()).toEqual({ status: 200, state: currentEpoch });
      expect(readFileSync(streamStateFile, "utf8")).toBe(persistedBaseline);
      expect(events.filter((event) => event.event === "state")).toEqual([]);
      expect(events.some((event) => event.event === "unavailable")).toBe(true);
      expect(
        sourceRequests.every((request) => request.authorization === null),
      ).toBe(true);
      expect(
        sourceRequests.every((request) =>
          [
            "/api/streaming/state",
            "/api/streaming/state/events",
            "/api/streaming/health",
          ].includes(request.pathname),
        ),
      ).toBe(true);
    } finally {
      releaseRest();
      for (const viewer of viewers) {
        await viewer.reader.cancel();
        await viewer.finished;
      }
    }
  }, 30_000);

  test("fails closed across origins, secrets, bodies, wallets, and providers", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "hyperbet-http-boundary-"),
    );
    ownedDirectories.add(directory);
    const rpcPort = await reservePort();
    const servicePort = await reservePort();
    let upstreamRequests = 0;

    const rpc = Bun.serve({
      hostname: "127.0.0.1",
      port: rpcPort,
      async fetch(request) {
        upstreamRequests += 1;
        const payload = (await request.json()) as { id?: unknown };
        if (payload.id === "oversized") {
          return Response.json({
            jsonrpc: "2.0",
            id: payload.id,
            result: `provider-secret-${"x".repeat(80 * 1024)}`,
          });
        }
        if (payload.id === "slow") {
          await Bun.sleep(1_000);
        }
        return Response.json({
          jsonrpc: "2.0",
          id: payload.id ?? 1,
          result: "ok",
        });
      },
    });
    ownedServers.add(rpc);

    const child = Bun.spawn([process.execPath, "--bun", "src/service.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        NODE_ENV: "development",
        HYPERBET_RUNTIME_ROLE: "service",
        PORT: String(servicePort),
        SOLANA_CLUSTER: "localnet",
        SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}`,
        CORS_ORIGINS: "http://app.test",
        ARENA_EXTERNAL_BET_WRITE_KEY: "write-secret",
        SOLANA_PROXY_TIMEOUT_MS: "500",
        SOLANA_RPC_PROXY_MAX_RESPONSE_BYTES: String(64 * 1024),
        KEEPER_DB_PATH: path.join(directory, "keeper.sqlite"),
        KEEPER_BOT_HEALTH_FILE: path.join(directory, "bot-health.json"),
        KEEPER_STREAM_STATE_FILE: path.join(directory, "stream-state.json"),
        HYPERBET_OPERATOR_ALERT_STATE_FILE: path.join(
          directory,
          "operator-alert-state.json",
        ),
        STREAM_STATE_SOURCE_EVENTS_ENABLED: "false",
        CONTRACT_POLL_MS: "60000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    ownedChildren.add(child);

    const baseUrl = `http://127.0.0.1:${servicePort}`;
    await waitForService(baseUrl);

    const rejectedOrigin = await fetch(`${baseUrl}/`, {
      headers: { origin: "http://app.test.attacker.invalid" },
    });
    expect(rejectedOrigin.status).toBe(403);
    expect(
      rejectedOrigin.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const preflight = await fetch(`${baseUrl}/api/proxy/solana/rpc`, {
      method: "OPTIONS",
      headers: {
        origin: "http://app.test",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://app.test",
    );
    expect(preflight.headers.get("access-control-allow-headers")).not.toContain(
      "x-arena-write-key",
    );

    const openStreams: Response[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const stream = await fetch(`${baseUrl}/api/streaming/state/events`, {
          headers: { origin: "http://app.test" },
        });
        expect(stream.status).toBe(200);
        openStreams.push(stream);
      }
      const excessStream = await fetch(
        `${baseUrl}/api/streaming/state/events`,
        { headers: { origin: "http://app.test" } },
      );
      expect(excessStream.status).toBe(429);
      expect(excessStream.headers.get("retry-after")).toBe("5");
    } finally {
      await Promise.all(openStreams.map((stream) => stream.body?.cancel()));
    }

    const invalidWallet = await fetch(
      `${baseUrl}/api/arena/invite/not-a-wallet`,
    );
    expect(invalidWallet.status).toBe(400);

    const malformedPath = await fetch(`${baseUrl}/api/arena/invite/%`);
    expect(malformedPath.status).toBe(400);
    expect((await fetch(baseUrl)).status).toBe(200);

    const wallet = "11111111111111111111111111111111";
    const initialInvite = await fetch(
      `${baseUrl}/api/arena/invite/${wallet}?platform=${"x".repeat(80)}`,
    );
    expect(initialInvite.status).toBe(200);
    const initialInviteBody = (await initialInvite.json()) as Record<
      string,
      unknown
    >;
    expect(initialInviteBody).toMatchObject({
      wallet,
      platformView: "unknown",
      inviteCode: null,
      inviteRegistrationRequired: true,
      referred: false,
    });
    expect(initialInviteBody).not.toHaveProperty("invitedWallets");
    expect(initialInviteBody).not.toHaveProperty("referredByWallet");

    const missingRegistrationKey = await fetch(
      `${baseUrl}/api/arena/invite/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet }),
      },
    );
    expect(missingRegistrationKey.status).toBe(401);

    const duplicateRegistrationKey = await fetch(
      `${baseUrl}/api/arena/invite/register`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-arena-write-key": "write-secret,write-secret",
        },
        body: JSON.stringify({ wallet }),
      },
    );
    expect(duplicateRegistrationKey.status).toBe(401);

    const registration = await fetch(`${baseUrl}/api/arena/invite/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-arena-write-key": "write-secret",
      },
      body: JSON.stringify({ wallet }),
    });
    expect(registration.status).toBe(200);
    const registrationPayload = (await registration.json()) as {
      wallet: string;
      inviteCode: string;
    };
    const registeredInviteCode = registrationPayload.inviteCode;
    expect(registrationPayload.wallet).toBe(wallet);
    expect(registeredInviteCode).toMatch(/^HS[A-F0-9]{8}$/u);

    const signedRegistrant = createWalletProofSigner();
    const signedRegistration = await fetch(
      `${baseUrl}/api/arena/invite/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: signedRegistrant.wallet,
          ...signedRegistrant.proof("invite-register", null),
        }),
      },
    );
    expect(signedRegistration.status).toBe(200);
    expect(await signedRegistration.json()).toMatchObject({
      wallet: signedRegistrant.wallet,
      inviteCode: expect.stringMatching(/^HS[A-F0-9]{8}$/u),
    });

    const signedInvitee = createWalletProofSigner();
    expect(registeredInviteCode).toMatch(/^HS[A-F0-9]{8}$/u);
    const redeemProof = signedInvitee.proof(
      "invite-redeem",
      registeredInviteCode,
    );
    const signedRedemption = await fetch(`${baseUrl}/api/arena/invite/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: signedInvitee.wallet,
        inviteCode: registeredInviteCode,
        ...redeemProof,
      }),
    });
    expect(signedRedemption.status).toBe(200);
    expect(await signedRedemption.json()).toEqual({
      result: { alreadyRedeemed: false, signupBonus: 50 },
    });

    const tamperedRedemption = await fetch(
      `${baseUrl}/api/arena/invite/redeem`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: createWalletProofSigner().wallet,
          inviteCode: registeredInviteCode,
          ...redeemProof,
        }),
      },
    );
    expect(tamperedRedemption.status).toBe(401);

    const oversizedBet = await fetch(
      `${baseUrl}/api/arena/bet/record-external`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-arena-write-key": "write-secret",
        },
        body: JSON.stringify({ filler: "x".repeat(33 * 1024) }),
      },
    );
    expect(oversizedBet.status).toBe(413);

    const rpcRequest = async (id: string) =>
      await fetch(`${baseUrl}/api/proxy/solana/rpc`, {
        method: "POST",
        headers: {
          origin: "http://app.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "getHealth",
          params: [],
        }),
      });

    const rpcSuccess = await rpcRequest("normal");
    expect(rpcSuccess.status).toBe(200);
    expect(await rpcSuccess.json()).toEqual({
      jsonrpc: "2.0",
      id: "normal",
      result: "ok",
    });

    const beforeUnsupported = upstreamRequests;
    const unsupported = await fetch(`${baseUrl}/api/proxy/solana/rpc`, {
      method: "POST",
      headers: {
        origin: "http://app.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "write",
        method: "sendTransaction",
        params: [],
      }),
    });
    expect(unsupported.status).toBe(403);
    expect(upstreamRequests).toBe(beforeUnsupported);

    const oversizedRpc = await rpcRequest("oversized");
    expect(oversizedRpc.status).toBe(502);
    const oversizedRpcText = await oversizedRpc.text();
    expect(oversizedRpcText).toContain("Failed to proxy Solana RPC request");
    expect(oversizedRpcText).not.toContain("provider-secret");

    const slowRpc = await rpcRequest("slow");
    expect(slowRpc.status).toBe(502);
    expect(await slowRpc.json()).toEqual({
      error: "Failed to proxy Solana RPC request",
    });
  }, 30_000);
});
