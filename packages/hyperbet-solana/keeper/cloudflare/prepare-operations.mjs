import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(process.argv[2] ?? join(here, ".runtime"));
const manifestBytes = readFileSync(join(here, "runtime-manifest.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const path = "keeper/src/db.ts";
const entry = manifest.files.find(file => file.path === path);
const bytes = readFileSync(join(runtime, path));
if (!entry || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
  throw new Error("Keeper database source does not match the pinned runtime");
}
let source = bytes.toString("utf8");
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned database source layout changed");
  source = source.replace(before, after);
}
replaceOnce('import { Database } from "bun:sqlite";\n', "");
replaceOnce('import path from "node:path";\n', "");
replaceOnce('import { fileURLToPath } from "node:url";\n', "");
replaceOnce('import type { AgentRating } from "./trueskill";\n',
  'import type { AgentRating } from "./keeper/src/trueskill";\n');
replaceOnce(`const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KEEPER_DB_PATH?.trim()
  ? process.env.KEEPER_DB_PATH.trim()
  : path.resolve(__dirname, "..", "keeper.sqlite");`,
  'const DB_PATH = "Cloudflare Durable Object";\nfunction createOperations(db: KeeperDatabase) {');
replaceOnce('const db = new Database(DB_PATH, { create: true });\n', "");
const operations = [...source.matchAll(/^export function ([A-Za-z0-9]+)\(/gm)].map(match => match[1]);
if (operations.length !== 20 || new Set(operations).size !== 20) {
  throw new Error("Expected all 20 pinned keeper database operations");
}
source = source.replace(/^export /gm, "");
// All function bodies and SQL statements above are unchanged. Only the host
// initialization and export scope are adapted after verifying the source hash.
const generated = `// Generated from verified keeper db.ts SHA-256 ${entry.sha256}.\n` +
  `type KeeperDatabase = {\n` +
  `  run(sql: string): void;\n` +
  `  prepare(sql: string): { all(...args: (string | number | null)[]): Record<string, unknown>[]; run(named: Record<string, string | number | null>): { lastInsertRowid: unknown } };\n` +
  `  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;\n` +
  `};\n` + source + `\nreturn { ${operations.join(", ")} };\n}\nexport { createOperations };\n` +
  `export const runtimeManifestSha256 = "${manifestSha256}";\n`;
writeFileSync(join(runtime, "operations.ts"), generated, { flag: "wx" });
console.log(`Prepared ${operations.length} unchanged keeper database operations`);
