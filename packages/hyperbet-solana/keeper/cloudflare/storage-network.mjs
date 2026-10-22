import { workerData } from "node:worker_threads";

const { port, url, token, timeoutMs } = workerData;
port.on("message", async ({ requestId, body, state }) => {
  let reply = { requestId, ok: false };
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("rejected");
    }
    const result = await response.json();
    if (!result || result.requestId !== requestId || result.ok !== true ||
        !Object.hasOwn(result, "value")) {
      throw new Error("invalid-response");
    }
    reply = { requestId, ok: true, value: result.value };
  } catch {
    // Do not expose endpoint, credentials, or provider response bodies.
  }
  port.postMessage(reply);
  const flag = new Int32Array(state);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
