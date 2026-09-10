import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

type KeeperTarget = "keeper:solana";

const rootDir = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(rootDir, "packages/hyperbet-solana");
const keeperDir = path.join(packageRoot, "keeper");
const keeperSourceRoot = path.join(keeperDir, "src");
const deploymentsRoot = path.join(packageRoot, "deployments");
const permittedSharedRuntimeFiles = new Set([
  path.join(packageRoot, "account-schema.ts"),
]);
const workspacePackagesRoot = path.join(keeperDir, "workspace-packages");
const workspaceRuntimeSourceRoot = path.join(
  keeperDir,
  "workspace-runtime-src",
);
const runtimeEntrypoints = ["service.ts", "duelBot.ts"] as const;
const workspaces = ["packages/hyperbet-solana/keeper"] as const;
const fullCommitSha = /^[0-9a-f]{40}$/u;

function parseArguments(argv: string[]): {
  target: KeeperTarget;
  releaseSha: string;
} {
  const target = argv
    .find((arg) => arg.startsWith("--target="))
    ?.slice("--target=".length);
  const releaseSha =
    argv
      .find((arg) => arg.startsWith("--release-sha="))
      ?.slice("--release-sha=".length) ?? "";

  if (target !== "keeper:solana") {
    throw new Error(
      "unsupported SOL-only deployment target; expected --target=keeper:solana",
    );
  }
  if (!fullCommitSha.test(releaseSha)) {
    throw new Error(
      "SOL keeper deployment requires --release-sha=<full-lowercase-commit-sha>",
    );
  }
  return { target, releaseSha };
}

function ensureCleanDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveLocalImport(importer: string, specifier: string): string {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [
        `${unresolved}.ts`,
        `${unresolved}.json`,
        path.join(unresolved, "index.ts"),
      ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `unable to resolve staged runtime import ${specifier} from ${path.relative(rootDir, importer)}`,
    );
  }
  if (
    !isWithin(resolved, keeperSourceRoot) &&
    !isWithin(resolved, deploymentsRoot) &&
    !permittedSharedRuntimeFiles.has(resolved)
  ) {
    throw new Error(
      `runtime import escapes the SOL keeper/deployment/schema closure: ${path.relative(rootDir, resolved)}`,
    );
  }
  if (/\.(?:test|fixture)\.[cm]?[jt]sx?$/u.test(resolved)) {
    throw new Error(
      `test or fixture entered the deployed runtime closure: ${path.relative(rootDir, resolved)}`,
    );
  }
  return resolved;
}

function collectRuntimeClosure(): string[] {
  const pending = runtimeEntrypoints.map((entrypoint) =>
    path.join(keeperSourceRoot, entrypoint),
  );
  const visited = new Set<string>();

  while (pending.length > 0) {
    const sourceFile = pending.pop();
    if (!sourceFile || visited.has(sourceFile)) continue;
    if (!existsSync(sourceFile)) {
      throw new Error(
        `missing SOL keeper runtime entrypoint: ${path.relative(rootDir, sourceFile)}`,
      );
    }
    visited.add(sourceFile);
    if (path.extname(sourceFile) === ".json") continue;

    const source = readFileSync(sourceFile, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const importedFile of imports) {
      if (!importedFile.fileName.startsWith(".")) continue;
      pending.push(resolveLocalImport(sourceFile, importedFile.fileName));
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

function stageRuntimeClosure(runtimeFiles: readonly string[]): void {
  for (const sourceFile of runtimeFiles) {
    let destinationFile: string;
    if (isWithin(sourceFile, keeperSourceRoot)) {
      destinationFile = path.join(
        workspaceRuntimeSourceRoot,
        path.relative(keeperSourceRoot, sourceFile),
      );
    } else {
      destinationFile = path.join(
        workspacePackagesRoot,
        path.relative(rootDir, sourceFile),
      );
    }
    mkdirSync(path.dirname(destinationFile), { recursive: true });
    cpSync(sourceFile, destinationFile, { force: true });
  }
}

function writeWorkspaceLockfile(
  workspaceManifest: Record<string, unknown>,
): void {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "hyperbet-sol-deploy-workspace-"),
  );
  try {
    writeFileSync(
      path.join(temporaryRoot, "package.json"),
      `${JSON.stringify(workspaceManifest, null, 2)}\n`,
    );
    cpSync(
      path.join(rootDir, "bun.lock"),
      path.join(temporaryRoot, "bun.lock"),
      {
        force: true,
      },
    );

    const stagedPackages = path.join(workspacePackagesRoot, "packages");
    if (existsSync(stagedPackages)) {
      cpSync(stagedPackages, path.join(temporaryRoot, "packages"), {
        recursive: true,
        force: true,
      });
    }
    const temporaryKeeperManifest = path.join(
      temporaryRoot,
      "packages/hyperbet-solana/keeper/package.json",
    );
    mkdirSync(path.dirname(temporaryKeeperManifest), { recursive: true });
    cpSync(path.join(keeperDir, "package.json"), temporaryKeeperManifest, {
      force: true,
    });

    execFileSync("bun", ["install", "--lockfile-only"], {
      cwd: temporaryRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: path.join(temporaryRoot, ".bun-cache"),
      },
    });
    cpSync(
      path.join(temporaryRoot, "bun.lock"),
      path.join(keeperDir, "workspace.bun.lock"),
      { force: true },
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function stageSolanaKeeper(releaseSha: string): void {
  ensureCleanDirectory(workspacePackagesRoot);
  ensureCleanDirectory(workspaceRuntimeSourceRoot);

  const runtimeFiles = collectRuntimeClosure();
  stageRuntimeClosure(runtimeFiles);

  const rootManifest = JSON.parse(
    readFileSync(path.join(rootDir, "package.json"), "utf8"),
  ) as { packageManager?: unknown };
  if (rootManifest.packageManager !== "bun@1.3.6") {
    throw new Error(
      "SOL deployment workspace requires packageManager bun@1.3.6",
    );
  }
  const workspaceManifest = {
    name: "@hyperbet/sol-keeper-release",
    private: true,
    packageManager: rootManifest.packageManager,
    workspaces,
  };
  writeFileSync(
    path.join(keeperDir, "workspace.package.json"),
    `${JSON.stringify(workspaceManifest, null, 2)}\n`,
  );
  writeWorkspaceLockfile(workspaceManifest);
  writeFileSync(
    path.join(workspaceRuntimeSourceRoot, "release-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, commitSha: releaseSha }, null, 2)}\n`,
  );

  const stagedKeeperFiles = runtimeFiles.filter((sourceFile) =>
    isWithin(sourceFile, keeperSourceRoot),
  ).length;
  const stagedDeploymentFiles = runtimeFiles.length - stagedKeeperFiles;
  console.log(
    JSON.stringify({
      ok: true,
      target: "keeper:solana",
      releaseSha,
      stagedKeeperFiles,
      stagedDeploymentFiles,
    }),
  );
}

if (process.argv.includes("--help")) {
  console.log(
    "usage: node --import tsx scripts/stage-deploy-workspace.ts --target=keeper:solana --release-sha=<full-lowercase-commit-sha>",
  );
} else {
  const { releaseSha } = parseArguments(process.argv.slice(2));
  stageSolanaKeeper(releaseSha);
}
