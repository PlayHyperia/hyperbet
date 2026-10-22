import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: here, encoding: "utf8",
}).trim();
const manifestBytes = readFileSync(join(here, "runtime-manifest.json"));
const manifest = JSON.parse(manifestBytes);
const output = resolve(process.argv[2] ?? join(here, ".runtime"));
if (existsSync(output)) throw new Error("Runtime output already exists; select a new output directory");
if (manifest.version !== 1 || manifest.sourceRoot !== "packages/hyperbet-solana" || !Array.isArray(manifest.files)) {
  throw new Error("Unsupported keeper runtime manifest");
}
const sources = new Map();
for (const entry of manifest.files) {
  if (
    typeof entry.path !== "string" ||
    !/^(keeper\/src\/|keeper\/(package\.json|bun\.lock|tsconfig\.json)$|deployments\/)/.test(entry.path) ||
    entry.path.split("/").some(part => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{40}$/.test(entry.commit) || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    sources.has(entry.path)
  ) throw new Error("Invalid or duplicate keeper runtime manifest entry");
  let bytes;
  try {
    bytes = execFileSync("git", ["show", `${entry.commit}:${manifest.sourceRoot}/${entry.path}`], {
      cwd: repository, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Cannot read pinned source ${entry.path}; fetch commit ${entry.commit} from this repository's origin`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`Pinned source hash mismatch: ${entry.path}`);
  }
  sources.set(entry.path, bytes);
}
if (sources.size !== 24) throw new Error("Keeper runtime manifest must contain the complete 24-file baseline");
mkdirSync(dirname(output), { recursive: true });
const temporary = mkdtempSync(join(dirname(output), ".keeper-runtime-"));
try {
  for (const [name, bytes] of sources) {
    const target = join(temporary, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(temporary, "provenance.json"), JSON.stringify({
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    bun: manifest.bun, files: manifest.files,
  }, null, 2) + "\n");
  renameSync(temporary, output);
} finally {
  if (existsSync(temporary)) rmSync(temporary, { recursive: true });
}
console.log(`Prepared ${sources.size} verified keeper files at ${output}`);
