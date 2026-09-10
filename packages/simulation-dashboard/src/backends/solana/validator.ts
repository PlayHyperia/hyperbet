import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";

type ProgramArtifact = {
  idlPath: string;
  soPath: string;
  programId: string;
};

export type ResolvedSolanaRuntimeAssets = {
  repoRoot: string;
  anchorDir: string;
  walletPath: string;
  mintAuthority: string;
  fightOracle: ProgramArtifact;
  duelMarket: ProgramArtifact;
};

export type SolanaValidatorHandle = {
  rpcUrl: string;
  wsUrl: string;
  assets: ResolvedSolanaRuntimeAssets;
  stop(): Promise<void>;
};

const DEFAULT_VALIDATOR_READY_TIMEOUT_MS = 180_000;
const DEFAULT_VALIDATOR_START_ATTEMPTS = 3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const DEFAULT_ANCHOR_DIR = join(
  REPO_ROOT,
  "packages",
  "hyperbet-solana",
  "anchor",
);

function configureSolanaToolPath(): void {
  const activeReleaseBin =
    process.env.SOLANA_ACTIVE_RELEASE_BIN?.trim() ||
    join(
      process.env.HOME ?? "",
      ".local",
      "share",
      "solana",
      "install",
      "active_release",
      "bin",
    );
  if (!existsSync(activeReleaseBin)) return;

  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!pathEntries.includes(activeReleaseBin)) {
    process.env.PATH = [activeReleaseBin, ...pathEntries].join(delimiter);
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return errorCode !== "ENOENT";
}

function expandHome(value: string): string {
  if (!value.startsWith("~/")) {
    return value;
  }
  return join(process.env.HOME ?? "", value.slice(2));
}

function resolveWalletPath(): string {
  const candidates = [
    process.env.ANCHOR_WALLET,
    process.env.E2E_SOLANA_BOOTSTRAP_KEYPAIR,
    process.env.SOLANA_BOOTSTRAP_KEYPAIR,
    "~/.config/solana/hyperia-keys/deployer.json",
    "~/.config/solana/id.json",
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(expandHome);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Missing required wallet file. Checked: ${candidates.join(", ")}`,
  );
}

function readKeypairPublicKey(walletPath: string): string {
  const secret = JSON.parse(readFileSync(walletPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
}

function resolveProgramId(idlPath: string): string {
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as {
    address?: string;
    metadata?: {
      address?: string;
    };
  };
  const programId = idl.address || idl.metadata?.address || "";
  if (!programId) {
    throw new Error(`Missing program address in ${idlPath}`);
  }
  return programId;
}

function resolveProgramArtifact(
  anchorDir: string,
  name: "fight_oracle" | "duel_market",
): ProgramArtifact {
  const idlPath = join(anchorDir, "target", "idl", `${name}.json`);
  const soPath = join(anchorDir, "target", "deploy", `${name}.so`);

  if (!existsSync(idlPath)) {
    throw new Error(`Missing required IDL: ${idlPath}`);
  }
  if (!existsSync(soPath)) {
    throw new Error(`Missing required deploy artifact: ${soPath}`);
  }

  return {
    idlPath,
    soPath,
    programId: resolveProgramId(idlPath),
  };
}

export function resolveSolanaRuntimeAssets(): ResolvedSolanaRuntimeAssets {
  const anchorDir =
    process.env.SIM_SOLANA_ANCHOR_DIR?.trim() || DEFAULT_ANCHOR_DIR;
  if (!existsSync(anchorDir)) {
    throw new Error(`Missing Solana anchor workspace: ${anchorDir}`);
  }

  const walletPath = resolveWalletPath();
  return {
    repoRoot: REPO_ROOT,
    anchorDir,
    walletPath,
    mintAuthority: readKeypairPublicKey(walletPath),
    fightOracle: resolveProgramArtifact(anchorDir, "fight_oracle"),
    duelMarket: resolveProgramArtifact(anchorDir, "duel_market"),
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate local port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        resolve(!error);
      });
    });
  });
}

async function getFreeRpcPort(): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = await getFreePort();
    if (candidate >= 65_535) {
      continue;
    }
    if (await canBindPort(candidate + 1)) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to allocate Solana validator RPC/WS port pair on 127.0.0.1",
  );
}

async function rpcRequest(
  rpcUrl: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`RPC ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function validatorExitError(
  validator: ChildProcess,
  rpcUrl: string,
  stage: string,
): Error {
  const code = validator.exitCode == null ? "null" : String(validator.exitCode);
  const signal = validator.signalCode ?? "null";
  return new Error(
    `solana-test-validator exited during ${stage} for ${rpcUrl} (code=${code}, signal=${signal})`,
  );
}

async function waitForRpcReady(
  rpcUrl: string,
  validator: ChildProcess,
  timeoutMs = DEFAULT_VALIDATOR_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (validator.exitCode !== null) {
      throw validatorExitError(validator, rpcUrl, "rpc readiness");
    }
    try {
      await rpcRequest(rpcUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
        params: [],
      });
      const blockhash = await rpcRequest(rpcUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "getLatestBlockhash",
        params: [{ commitment: "confirmed" }],
      });
      if (blockhash?.result?.value?.blockhash) {
        return;
      }
    } catch {
      // Validator still warming up.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Solana validator at ${rpcUrl}`);
}

async function waitForProgram(
  rpcUrl: string,
  programId: string,
  validator: ChildProcess,
  timeoutMs = DEFAULT_VALIDATOR_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (validator.exitCode !== null) {
      throw validatorExitError(
        validator,
        rpcUrl,
        `program readiness for ${programId}`,
      );
    }
    try {
      const result = await rpcRequest(rpcUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "getAccountInfo",
        params: [programId, { encoding: "base64" }],
      });
      if (result?.result?.value?.executable === true) {
        return;
      }
    } catch {
      // Retry while validator finishes loading programs.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Program ${programId} did not become executable on ${rpcUrl}`,
  );
}

async function getConfirmedSlot(rpcUrl: string): Promise<number> {
  const result = await rpcRequest(rpcUrl, {
    jsonrpc: "2.0",
    id: 4,
    method: "getSlot",
    params: [{ commitment: "confirmed" }],
  });
  const slot = result?.result;
  if (typeof slot !== "number") {
    throw new Error(`Unable to read confirmed slot from ${rpcUrl}`);
  }
  return slot;
}

async function waitForSlotAdvances(
  rpcUrl: string,
  minimumAdvances: number,
  validator: ChildProcess,
  timeoutMs = DEFAULT_VALIDATOR_READY_TIMEOUT_MS,
): Promise<void> {
  const targetAdvances = Math.max(1, minimumAdvances);
  const baselineSlot = await getConfirmedSlot(rpcUrl);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (validator.exitCode !== null) {
      throw validatorExitError(
        validator,
        rpcUrl,
        "confirmed slot advance warmup",
      );
    }
    const currentSlot = await getConfirmedSlot(rpcUrl);
    if (currentSlot >= baselineSlot + targetAdvances) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for ${targetAdvances} confirmed slot advances on ${rpcUrl}`,
  );
}

async function startSolanaValidatorAttempt(): Promise<SolanaValidatorHandle> {
  if (!commandExists("solana-test-validator")) {
    throw new Error("Missing required command: solana-test-validator");
  }

  const assets = resolveSolanaRuntimeAssets();
  const rpcPort = await getFreeRpcPort();
  let faucetPort = await getFreePort();
  while (faucetPort === rpcPort || faucetPort === rpcPort + 1) {
    faucetPort = await getFreePort();
  }

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const wsUrl = `ws://127.0.0.1:${rpcPort + 1}`;
  const ledgerDir = mkdtempSync(join(tmpdir(), "hyperbet-solana-sim-"));

  const validatorArgs = [
    "--reset",
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    String(rpcPort),
    "--faucet-port",
    String(faucetPort),
    "--mint",
    assets.mintAuthority,
    "--ledger",
    ledgerDir,
    "--upgradeable-program",
    assets.fightOracle.programId,
    assets.fightOracle.soPath,
    assets.walletPath,
    "--upgradeable-program",
    assets.duelMarket.programId,
    assets.duelMarket.soPath,
    assets.walletPath,
  ];

  let validator: ChildProcess | null = spawn(
    "solana-test-validator",
    validatorArgs,
    {
      cwd: assets.anchorDir,
      env: process.env,
      stdio: "ignore",
    },
  );

  const stop = async () => {
    if (!validator || validator.killed || validator.exitCode !== null) {
      validator = null;
      rmSync(ledgerDir, { recursive: true, force: true });
      return;
    }

    const currentValidator = validator;
    validator = null;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          currentValidator.kill("SIGKILL");
        } catch {
          // Ignore force-kill failures.
        }
      }, 5_000);

      currentValidator.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        currentValidator.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });

    rmSync(ledgerDir, { recursive: true, force: true });
  };

  try {
    await waitForRpcReady(rpcUrl, validator);
    await waitForProgram(rpcUrl, assets.fightOracle.programId, validator);
    await waitForProgram(rpcUrl, assets.duelMarket.programId, validator);
    // The program accounts can report executable slightly before the validator
    // is ready to execute and confirm the first program instructions.
    await waitForSlotAdvances(rpcUrl, 1, validator);
    return {
      rpcUrl,
      wsUrl,
      assets,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function startSolanaValidator(): Promise<SolanaValidatorHandle> {
  configureSolanaToolPath();
  let lastError: unknown = null;

  for (
    let attempt = 1;
    attempt <= DEFAULT_VALIDATOR_START_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await startSolanaValidatorAttempt();
    } catch (error) {
      lastError = error;
      if (attempt < DEFAULT_VALIDATOR_START_ATTEMPTS) {
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
