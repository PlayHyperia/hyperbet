import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const anchorIdlDir = path.join(rootDir, "anchor", "target", "idl");
const anchorTypesDir = path.join(rootDir, "anchor", "target", "types");
const artifactTargets = [
  {
    label: "hyperbet-solana app",
    dir: path.join(rootDir, "app", "src", "idl"),
    copyTypes: true,
  },
  {
    label: "hyperbet-solana keeper",
    dir: path.join(rootDir, "keeper", "src", "idl"),
    copyTypes: true,
  },
  {
    label: "hyperbet-ui",
    dir: path.join(rootDir, "..", "hyperbet-ui", "src", "idl"),
    copyTypes: true,
  },
  {
    label: "market-maker-bot",
    dir: path.join(rootDir, "..", "market-maker-bot", "src", "idl"),
    copyTypes: false,
    programs: ["duel_market"],
  },
  {
    label: "TypeScript SDK",
    dir: path.join(rootDir, "..", "hyperbet-sdk", "src", "solana", "idl"),
    copyTypes: false,
  },
  {
    label: "Python SDK",
    dir: path.join(
      rootDir,
      "..",
      "hyperbet-sdk-py",
      "hyperbet_sdk",
      "solana",
      "idl",
    ),
    copyTypes: false,
  },
];

const programNames = ["fight_oracle", "duel_market"];

for (const programName of programNames) {
  const sourceFile = path.join(anchorIdlDir, `${programName}.json`);
  if (!existsSync(sourceFile)) {
    throw new Error(`Missing generated Anchor IDL: ${sourceFile}`);
  }

  const sourceTypeFile = path.join(anchorTypesDir, `${programName}.ts`);
  for (const target of artifactTargets) {
    if (!existsSync(target.dir)) continue;
    if (target.programs && !target.programs.includes(programName)) continue;
    cpSync(sourceFile, path.join(target.dir, `${programName}.json`));
    if (target.copyTypes && existsSync(sourceTypeFile)) {
      cpSync(sourceTypeFile, path.join(target.dir, `${programName}.ts`));
    }
  }
}

console.log(
  "[sync-anchor-artifacts] copied Solana Anchor IDLs and generated types into downstream PM consumers",
);
