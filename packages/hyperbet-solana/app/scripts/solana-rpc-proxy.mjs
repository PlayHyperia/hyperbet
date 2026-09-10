import fs from "node:fs";
import { createServer } from "node:http";
import { URL } from "node:url";

import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { WebSocket, WebSocketServer } from "ws";

const rpcTarget = process.env.SOLANA_RPC_TARGET?.trim();
if (!rpcTarget) {
  throw new Error("SOLANA_RPC_TARGET is required");
}

const wsTarget =
  process.env.SOLANA_WS_TARGET?.trim() || rpcTarget.replace(/^http/i, "ws");
const port = Number.parseInt(process.env.SOLANA_PROXY_PORT || "18898", 10);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error(
    `Invalid SOLANA_PROXY_PORT: ${process.env.SOLANA_PROXY_PORT}`,
  );
}

const e2eFaultsEnabled =
  process.env.SOLANA_PROXY_E2E_FAULTS_ENABLED?.trim().toLowerCase() === "true";
const e2eFaultControlPath =
  process.env.SOLANA_PROXY_E2E_FAULT_CONTROL_PATH?.trim() || "";
const e2eFaultHoldMs = Number.parseInt(
  process.env.SOLANA_PROXY_E2E_FAULT_HOLD_MS || "30000",
  10,
);
if (
  e2eFaultsEnabled &&
  (!e2eFaultControlPath ||
    !Number.isInteger(e2eFaultHoldMs) ||
    e2eFaultHoldMs < 1000 ||
    e2eFaultHoldMs > 120000)
) {
  throw new Error(
    "enabled Solana RPC E2E faults require a control path and a 1000-120000 ms hold",
  );
}

function corsHeaders(req) {
  const originHeader = req?.headers?.origin;
  const requestHeaders = req?.headers?.["access-control-request-headers"];
  const privateNetworkRequest =
    req?.headers?.["access-control-request-private-network"] === "true";

  return {
    "Access-Control-Allow-Origin":
      typeof originHeader === "string" && originHeader.length > 0
        ? originHeader
        : "*",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
    "Access-Control-Allow-Headers":
      typeof requestHeaders === "string" && requestHeaders.length > 0
        ? requestHeaders
        : "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "600",
    ...(privateNetworkRequest
      ? { "Access-Control-Allow-Private-Network": "true" }
      : {}),
  };
}

function filterRequestHeaders(headers) {
  const filtered = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    const lower = name.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "upgrade"
    ) {
      continue;
    }
    filtered[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return filtered;
}

function filterResponseHeaders(headers) {
  const filtered = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === "content-length" ||
      lower === "connection" ||
      lower === "transfer-encoding" ||
      lower === "access-control-allow-origin" ||
      lower === "access-control-allow-methods" ||
      lower === "access-control-allow-headers" ||
      lower === "access-control-allow-private-network" ||
      lower === "access-control-max-age" ||
      lower === "vary"
    ) {
      return;
    }
    filtered[name] = value;
  });
  return filtered;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function resolveTarget(base, requestUrl) {
  const target = new URL(requestUrl || "/", base);
  if (target.pathname === "/verifier") target.pathname = "/";
  return target;
}

function isVerifierLaneRequest(requestUrl) {
  try {
    return (
      new URL(requestUrl || "/", "http://127.0.0.1").pathname === "/verifier"
    );
  } catch {
    return false;
  }
}

function getRpcMethod(body) {
  if (!body || body.length === 0) return null;
  try {
    const payload = JSON.parse(body.toString("utf8"));
    return typeof payload?.method === "string" ? payload.method : null;
  } catch {
    return null;
  }
}

function parseRpcPayload(body) {
  if (!body || body.length === 0) return null;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function transactionStaticAccountKeys(rpcPayload) {
  const encoded = rpcPayload?.params?.[0];
  if (typeof encoded !== "string" || encoded.length === 0) return [];
  const bytes = Buffer.from(encoded, "base64");
  try {
    return VersionedTransaction.deserialize(
      bytes,
    ).message.staticAccountKeys.map((key) => key.toBase58());
  } catch {
    try {
      const transaction = Transaction.from(bytes);
      return transaction
        .compileMessage()
        .accountKeys.map((key) => key.toBase58());
    } catch {
      return [];
    }
  }
}

function readE2eFaultControl() {
  if (!e2eFaultsEnabled || !e2eFaultControlPath) return null;
  try {
    const candidate = JSON.parse(fs.readFileSync(e2eFaultControlPath, "utf8"));
    const supportedMode =
      candidate?.mode === "hold_send_transaction_after_forward" ||
      candidate?.mode === "hide_get_transaction_after_forward";
    const supportedState =
      candidate?.state === "armed" ||
      candidate?.state === "observed" ||
      candidate?.state === "released";
    if (
      candidate?.version !== 1 ||
      !supportedMode ||
      !supportedState ||
      typeof candidate?.faultId !== "string" ||
      !candidate.faultId.trim() ||
      typeof candidate?.requiredAccount !== "string" ||
      !candidate.requiredAccount.trim() ||
      typeof candidate?.requiredProgramId !== "string" ||
      !candidate.requiredProgramId.trim()
    ) {
      return null;
    }
    if (
      candidate.state !== "armed" &&
      (typeof candidate.signature !== "string" || !candidate.signature.trim())
    ) {
      return null;
    }
    if (
      candidate.mode === "hold_send_transaction_after_forward" &&
      candidate.state === "released"
    ) {
      return null;
    }
    if (
      candidate.mode === "hide_get_transaction_after_forward" &&
      candidate.hiddenLookupCount !== undefined &&
      candidate.hiddenLookupCount !== 0 &&
      candidate.hiddenLookupCount !== 1
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function writeE2eFaultControl(control) {
  const temporaryPath = `${e2eFaultControlPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(control, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, e2eFaultControlPath);
}

function recordE2eFaultObservation(control, signature) {
  const observedAtMs = Date.now();
  const observation = {
    ...control,
    state: "observed",
    signature,
    observedAtMs,
    ...(control.mode === "hold_send_transaction_after_forward"
      ? { holdUntilMs: observedAtMs + e2eFaultHoldMs }
      : { hiddenLookupCount: 0 }),
  };
  writeE2eFaultControl(observation);
  return observation;
}

async function maybeHoldForwardedSendTransaction(
  rpcMethod,
  requestPayload,
  responsePayload,
) {
  if (rpcMethod !== "sendTransaction") return;
  const control = readE2eFaultControl();
  if (!control || control.state !== "armed") return;
  const keys = transactionStaticAccountKeys(requestPayload);
  if (
    !keys.includes(control.requiredAccount) ||
    !keys.includes(control.requiredProgramId)
  ) {
    return;
  }
  let signature = null;
  try {
    const response = JSON.parse(responsePayload.toString("utf8"));
    signature = typeof response?.result === "string" ? response.result : null;
  } catch {
    signature = null;
  }
  if (!signature) return;

  const observation = recordE2eFaultObservation(control, signature);
  if (control.mode === "hide_get_transaction_after_forward") {
    console.log(
      `[solana-rpc-proxy] E2E fault ${observation.faultId} observed forwarded sendTransaction ${signature}; waiting to hide one finalized getTransaction response`,
    );
    return;
  }
  console.log(
    `[solana-rpc-proxy] E2E fault ${observation.faultId} observed forwarded sendTransaction ${signature}; holding response for ${e2eFaultHoldMs}ms`,
  );
  await new Promise((resolve) => setTimeout(resolve, e2eFaultHoldMs));
}

function maybeHideFinalizedTransactionLookup(
  rpcMethod,
  requestPayload,
  responsePayload,
  requestUrl,
) {
  if (rpcMethod !== "getTransaction" || !isVerifierLaneRequest(requestUrl)) {
    return responsePayload;
  }
  const control = readE2eFaultControl();
  if (
    !control ||
    control.mode !== "hide_get_transaction_after_forward" ||
    control.state !== "observed" ||
    control.hiddenLookupCount !== 0
  ) {
    return responsePayload;
  }
  const signature = requestPayload?.params?.[0];
  const options = requestPayload?.params?.[1];
  if (
    signature !== control.signature ||
    options == null ||
    typeof options !== "object" ||
    options.commitment !== "finalized"
  ) {
    return responsePayload;
  }

  let response;
  try {
    response = JSON.parse(responsePayload.toString("utf8"));
  } catch {
    return responsePayload;
  }
  if (response?.result == null) return responsePayload;

  const hiddenAtMs = Date.now();
  writeE2eFaultControl({
    ...control,
    state: "released",
    hiddenLookupCount: 1,
    hiddenAtMs,
    releasedAtMs: hiddenAtMs,
    requestedCommitment: "finalized",
    requestedLane: "verifier",
  });
  console.log(
    `[solana-rpc-proxy] E2E fault ${control.faultId} hid one finalized getTransaction response for ${signature}; subsequent lookups are released`,
  );
  return Buffer.from(
    JSON.stringify({
      ...response,
      result: null,
    }),
  );
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    console.log(
      `[solana-rpc-proxy] OPTIONS ${req.url || "/"} origin=${req.headers.origin || "-"} private-network=${req.headers["access-control-request-private-network"] || "-"}`,
    );
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  try {
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await readBody(req);
    const rpcMethod = getRpcMethod(body);
    const requestPayload = parseRpcPayload(body);
    const upstream = await fetch(resolveTarget(rpcTarget, req.url), {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
      body,
    });
    console.log(
      `[solana-rpc-proxy] ${req.method || "GET"} ${req.url || "/"} ${rpcMethod || "-"} -> ${upstream.status}`,
    );

    if (!upstream.body) {
      res.writeHead(upstream.status, {
        ...filterResponseHeaders(upstream.headers),
        ...corsHeaders(req),
      });
      res.end();
      return;
    }

    let payload = Buffer.from(await upstream.arrayBuffer());
    payload = maybeHideFinalizedTransactionLookup(
      rpcMethod,
      requestPayload,
      payload,
      req.url,
    );
    await maybeHoldForwardedSendTransaction(rpcMethod, requestPayload, payload);
    res.writeHead(upstream.status, {
      ...filterResponseHeaders(upstream.headers),
      ...corsHeaders(req),
    });
    res.end(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[solana-rpc-proxy] ${req.method || "GET"} ${req.url || "/"} -> 502 ${message}`,
    );
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req),
    });
    res.end(JSON.stringify({ error: message }));
  }
});

const wsServer = new WebSocketServer({ noServer: true });

function isForwardableWebSocketCloseCode(code) {
  return (
    code === 1000 ||
    (code >= 1001 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

function boundedWebSocketCloseReason(reason) {
  const text = Buffer.isBuffer(reason)
    ? reason.toString("utf8")
    : String(reason ?? "");
  let bounded = "";
  for (const character of text) {
    const candidate = `${bounded}${character}`;
    if (Buffer.byteLength(candidate, "utf8") > 123) break;
    bounded = candidate;
  }
  return bounded;
}

function closeWebSocketPeer(peer, code, reason) {
  if (peer.readyState === WebSocket.CONNECTING) {
    peer.terminate();
    return;
  }
  if (peer.readyState !== WebSocket.OPEN) return;

  if (!isForwardableWebSocketCloseCode(code)) {
    peer.close();
    return;
  }

  peer.close(code, boundedWebSocketCloseReason(reason));
}

server.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (clientSocket) => {
    const upstream = new WebSocket(resolveTarget(wsTarget, request.url), {
      headers: filterRequestHeaders(request.headers),
    });

    clientSocket.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    clientSocket.on("close", (code, reason) => {
      closeWebSocketPeer(upstream, code, reason);
    });
    clientSocket.on("error", () => {
      closeWebSocketPeer(upstream, 1011, "client-error");
    });

    upstream.on("message", (data, isBinary) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
      }
    });
    upstream.on("close", (code, reason) => {
      closeWebSocketPeer(clientSocket, code, reason);
    });
    upstream.on("error", () => {
      closeWebSocketPeer(clientSocket, 1011, "upstream-error");
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[solana-rpc-proxy] listening on http://127.0.0.1:${port} -> ${rpcTarget}`,
  );
});
