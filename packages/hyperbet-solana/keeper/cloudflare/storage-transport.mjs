import { randomUUID } from "node:crypto";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

export class StorageTransportError extends Error {
  constructor(code) {
    super(`Keeper storage transport: ${code}`);
    this.name = "StorageTransportError";
    this.code = code;
  }
}

function assertJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)) {
    throw new StorageTransportError("invalid-json-value");
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonValue(item, ancestors);
  }
  ancestors.delete(value);
}

/** Synchronous calls preserve the pinned keeper's write-through ordering. */
export function createStorageTransport({ url, token, timeoutMs = 10_000 }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) {
    throw new StorageTransportError("invalid-endpoint");
  }
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new StorageTransportError("invalid-credential");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new StorageTransportError("invalid-timeout");
  }
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./storage-network.mjs", import.meta.url), {
    workerData: { port: port2, url: endpoint.href, token, timeoutMs },
    transferList: [port2],
  });
  let failed = false;
  let closed = false;
  let closing;
  // A blocked caller cannot process events. Its own deadline also covers a
  // thread that exits before it can publish a reply.
  worker.on("error", () => { failed = true; });
  worker.on("exit", () => { failed = true; });

  return {
    call(operation, args) {
      if (closed) throw new StorageTransportError("closed");
      if (failed) throw new StorageTransportError("outcome-unconfirmed");
      if (typeof operation !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(operation) ||
          !Array.isArray(args)) {
        throw new StorageTransportError("invalid-request");
      }
      const requestId = randomUUID();
      // Serialization errors happen before dispatch and do not poison state.
      assertJsonValue(args);
      const body = JSON.stringify({ requestId, operation, args });
      const state = new SharedArrayBuffer(4);
      const flag = new Int32Array(state);
      try {
        port1.postMessage({ requestId, body, state });
        const deadline = performance.now() + timeoutMs + 2_000;
        while (Atomics.load(flag, 0) === 0) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new Error("deadline");
          Atomics.wait(flag, 0, 0, remaining);
        }
        const reply = receiveMessageOnPort(port1)?.message;
        if (!reply || reply.requestId !== requestId || reply.ok !== true) {
          throw new Error("unconfirmed");
        }
        return reply.value;
      } catch {
        // A response failure cannot prove whether a write committed. Never
        // retry or permit a later operation to overtake the uncertain write.
        failed = true;
        throw new StorageTransportError("outcome-unconfirmed");
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      port1.close();
      closing = worker.terminate().then(() => {});
      return closing;
    },
  };
}
