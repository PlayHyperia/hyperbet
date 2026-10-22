import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2] ?? join(here, ".runtime"));
const output = resolve(process.argv[3] ?? join(here, ".host-runtime"));
if (existsSync(output)) throw new Error("Keeper host output already exists");
const manifestBytes = readFileSync(join(here, "runtime-manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (manifest.version !== 1 || manifest.bun !== "1.3.8" || manifest.sourceRoot !== "packages/hyperbet-solana" ||
    !Array.isArray(manifest.files)) throw new Error("Unsupported keeper runtime manifest");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const files = new Map();
for (const entry of manifest.files) {
  if (typeof entry.path !== "string" || entry.path.split("/").some(part => !part || part === "." || part === "..") ||
      entry.path.startsWith("/") || files.has(entry.path)) throw new Error("Invalid keeper manifest path");
  const bytes = readFileSync(join(source, entry.path));
  if (sha256(bytes) !== entry.sha256) throw new Error(`Keeper runtime hash mismatch: ${entry.path}`);
  files.set(entry.path, bytes);
}
if (files.size !== 24) throw new Error("Incomplete keeper runtime");
const nativeDb = files.get("keeper/src/db.ts");
const operations = [...nativeDb.toString("utf8").matchAll(/^export function ([A-Za-z0-9]+)\(/gm)].map(match => match[1]);
if (operations.length !== 20 || new Set(operations).size !== 20) throw new Error("Incomplete keeper database API");
const shim = `// Generated Cloudflare host adapter; trading and service source remain pinned.
import { createStorageTransport } from "../cloudflare/storage-transport.mjs";
import { encodeValue, decodeValue } from "../cloudflare/value-codec.mjs";
import { assertRuntimeIsolation, failClosed } from "../cloudflare/runtime-isolation.mjs";
export type * from "./db-native";
type Native = typeof import("./db-native");
assertRuntimeIsolation();
const transport = createStorageTransport({
  url: process.env.KEEPER_STORAGE_URL ?? "",
  token: process.env.KEEPER_STORAGE_TOKEN ?? "",
  ownerId: process.env.KEEPER_STORAGE_OWNER_ID ?? "",
});
function invoke(operation: keyof Native, args: unknown[]): unknown {
  try { return decodeValue(transport.call(operation, args.map(encodeValue))); }
  catch (error) { return failClosed(error); }
}
${operations.map(name => `export const ${name}: Native["${name}"] = (...args) => invoke("${name}", args) as ReturnType<Native["${name}"]>;`).join("\n")}
`;
files.set("keeper/src/db-native.ts", nativeDb);
files.set("keeper/src/db.ts", Buffer.from(shim));
for (const name of ["storage-transport.mjs", "storage-transport.d.mts", "storage-network.mjs",
  "value-codec.mjs", "value-codec.d.mts", "runtime-isolation.mjs", "runtime-isolation.d.mts",
  "runtime-supervisor.mjs", "runtime-child.mjs"]) {
  files.set(`keeper/cloudflare/${name}`, readFileSync(join(here, name)));
}
mkdirSync(dirname(output), { recursive: true });
const temporary = mkdtempSync(join(dirname(output), ".keeper-host-"));
try {
  for (const [path, bytes] of files) {
    const target = join(temporary, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(temporary, "host-provenance.json"), JSON.stringify({
    runtimeManifestSha256: sha256(manifestBytes), bun: manifest.bun,
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
  }, null, 2));
  renameSync(temporary, output);
} finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true }); }
console.log(`Prepared keeper Cloudflare host with ${operations.length} synchronous database exports`);
