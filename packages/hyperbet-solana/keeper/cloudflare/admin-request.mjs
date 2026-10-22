import { importPreparedStorage, prepareStorageImport } from "./storage-import.mjs";

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const tokenValid = token => typeof token === "string" && /^[A-Za-z0-9_-]{32,}$/.test(token);
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export async function handleAdminRequest(request, { adminToken, storageToken, controller, storage, manifestSha256, enabled, runtimeEnv }) {
  // A runtime credential can never be used as an administrative credential.
  if (!tokenValid(adminToken) || !tokenValid(storageToken) || adminToken === storageToken) return json({ error: "unconfigured" }, 503);
  const encoder = new TextEncoder();
  const hashes = await Promise.all([request.headers.get("authorization") ?? "", `Bearer ${adminToken}`]
    .map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  if (difference) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  if (url.search) return json({ error: "invalid-request" }, 400);
  if (url.pathname === "/admin/status" && request.method === "GET") return json(controller.status());
  const paths = ["/admin/import", "/admin/activate", "/admin/stop", "/admin/reconcile"];
  if (!paths.includes(url.pathname)) return json({ error: "not-found" }, 404);
  if (request.method !== "POST") return json({ error: "method-not-allowed" }, 405);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") return json({ error: "json-required" }, 415);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid-json" }, 400); }
  try {
    if (url.pathname === "/admin/import") {
      const prepared = await prepareStorageImport(body, manifestSha256);
      if (controller.status().running) return json({ error: "container-running" }, 409);
      return json(importPreparedStorage(storage, prepared));
    }
    if (url.pathname === "/admin/activate") {
      if (!exact(body, ["snapshotSha256"])) return json({ error: "invalid-request" }, 400);
      if (enabled !== "true") return json({ error: "activation-disabled" }, 409);
      return json(await controller.activate(body.snapshotSha256, runtimeEnv()));
    }
    if (url.pathname === "/admin/stop") {
      if (!exact(body, [])) return json({ error: "invalid-request" }, 400);
      return json(await controller.stop());
    }
    if (!exact(body, ["ownerId", "evidenceSha256"])) return json({ error: "invalid-request" }, 400);
    return json(await controller.reconcile(body.ownerId, body.evidenceSha256));
  } catch {
    // Provider errors and imported rows may contain private runtime data.
    return json({ error: "operation-not-confirmed" }, 409);
  }
}
