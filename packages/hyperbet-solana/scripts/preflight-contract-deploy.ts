import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

import {
  resolveSolanaV1Deployment,
  type SolanaV1Cluster,
} from "../deployments/v1";
import { resolveExpectedUpgradeAuthority } from "../keeper/src/solanaProgramIdentity";
import {
  readKeypairPubkey,
  resolveStageAProgramKeypairPath,
  resolveStageAWalletPath,
} from "./stage-a-identity";
import { describeRpcEndpoint } from "./solana-deployment-evidence";
import { fetchSolanaProgramDeploymentIdentity } from "./solana-deployment-identity";
import {
  deriveFightOracleConfigPda,
  evaluateFightOracleAccountSchema,
} from "./solana-account-schema";

type Target = "testnet" | "mainnet";

interface SolanaProgramCheck {
  label: string;
  binaryName: "fight_oracle" | "duel_market";
  manifestField: "fightOracleProgramId" | "duelMarketProgramId";
}

const PROGRAMS: readonly SolanaProgramCheck[] = [
  {
    label: "fight oracle",
    binaryName: "fight_oracle",
    manifestField: "fightOracleProgramId",
  },
  {
    label: "duel market",
    binaryName: "duel_market",
    manifestField: "duelMarketProgramId",
  },
] as const;

function usage(): never {
  console.log(
    "usage: bun run packages/hyperbet-solana/scripts/preflight-contract-deploy.ts [--target testnet|mainnet] [--cluster localnet|devnet|testnet|mainnet-beta] [--require-deployed]",
  );
  process.exit(0);
}

function parseTarget(argv: string[]): Target {
  const index = argv.findIndex((arg) => arg === "--target");
  const value = index >= 0 ? argv[index + 1] : "testnet";
  if (value === "testnet" || value === "mainnet") {
    return value;
  }
  throw new Error(`Unsupported --target value '${value}'`);
}

function parseOptionalCluster(argv: string[]): SolanaV1Cluster | null {
  const index = argv.findIndex((arg) => arg === "--cluster");
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value) {
    throw new Error("Missing value for --cluster");
  }
  if (
    value === "localnet" ||
    value === "devnet" ||
    value === "testnet" ||
    value === "mainnet-beta"
  ) {
    return value;
  }
  throw new Error(`Unsupported --cluster value '${value}'`);
}

function resolveRpcUrl(cluster: SolanaV1Cluster): string {
  const explicit = process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

function readJson(filepath: string): unknown {
  return JSON.parse(fs.readFileSync(filepath, "utf8"));
}

function readIdlAddress(filepath: string): string | null {
  if (!fs.existsSync(filepath)) return null;
  const parsed = readJson(filepath) as {
    address?: unknown;
    metadata?: { address?: unknown };
  };
  const direct =
    typeof parsed.address === "string" ? parsed.address.trim() : "";
  if (direct.length > 0) return direct;
  const metadata =
    typeof parsed.metadata?.address === "string"
      ? parsed.metadata.address.trim()
      : "";
  return metadata.length > 0 ? metadata : null;
}

function appendStatus(
  ok: boolean,
  message: string,
  failures: string[],
  warnings: string[],
  warning = false,
): void {
  const prefix = ok ? "[ok]" : warning ? "[warn]" : "[fail]";
  console.log(`${prefix} ${message}`);
  if (!ok) {
    if (warning) warnings.push(message);
    else failures.push(message);
  }
}

function getTargetCluster(target: Target): SolanaV1Cluster {
  return target === "mainnet" ? "mainnet-beta" : "testnet";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) usage();
  const target = parseTarget(argv);
  const cluster = parseOptionalCluster(argv) ?? getTargetCluster(target);
  const requireDeployed = argv.includes("--require-deployed");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const bettingDir = path.resolve(__dirname, "..");
  const anchorDir = path.join(bettingDir, "anchor");
  const appDir = path.join(bettingDir, "app");
  const keeperDir = path.join(bettingDir, "keeper");

  const failures: string[] = [];
  const warnings: string[] = [];
  const deployment = resolveSolanaV1Deployment(cluster);
  const rpcUrl = resolveRpcUrl(cluster);
  const walletPath = resolveStageAWalletPath();
  const walletAddress = readKeypairPubkey(walletPath);
  const configuredUpgradeAuthority =
    process.env.SOLANA_EXPECTED_UPGRADE_AUTHORITY?.trim() ||
    (cluster === "mainnet-beta" ? undefined : walletAddress);
  const expectedUpgradeAuthority = resolveExpectedUpgradeAuthority({
    value: configuredUpgradeAuthority,
    required: cluster === "mainnet-beta",
    label: "Solana v1 deployment",
  });
  const connection = new Connection(rpcUrl, {
    commitment: "finalized",
  });

  console.log(`[preflight] target=${target}`);
  console.log(`[preflight] solana cluster=${cluster}`);
  console.log("[preflight] scope=solana-duel-v1");
  console.log(
    `[preflight] mode=${requireDeployed ? "post-deploy-verification" : "pre-deploy"}`,
  );
  console.log(`[preflight] rpc=${describeRpcEndpoint(rpcUrl)}`);
  console.log(`[preflight] wallet=${walletPath}`);
  console.log(`[preflight] walletAddress=${walletAddress}`);
  console.log(
    `[preflight] expectedUpgradeAuthority=${
      expectedUpgradeAuthority === null
        ? "immutable"
        : (expectedUpgradeAuthority?.toBase58() ?? "unchecked")
    }`,
  );

  for (const program of PROGRAMS) {
    const expected = deployment[program.manifestField];
    const programId = new PublicKey(expected);
    const keypairPath =
      cluster === "mainnet-beta"
        ? path.join(
            anchorDir,
            "target",
            "deploy",
            `${program.binaryName}-keypair.json`,
          )
        : resolveStageAProgramKeypairPath(program.binaryName);
    const anchorIdlPath = path.join(
      anchorDir,
      "target",
      "idl",
      `${program.binaryName}.json`,
    );
    const appIdlPath = path.join(
      appDir,
      "src",
      "idl",
      `${program.binaryName}.json`,
    );
    const keeperIdlPath = path.join(
      keeperDir,
      "src",
      "idl",
      `${program.binaryName}.json`,
    );

    let deploymentMode: "fresh-deploy" | "upgrade" | null = null;
    try {
      const identity = await fetchSolanaProgramDeploymentIdentity({
        connection,
        label: program.label,
        programId,
        expectedUpgradeAuthority,
        requireDeployed,
      });
      deploymentMode = identity.mode;
      const identityDetail =
        identity.mode === "upgrade"
          ? `ProgramData=${identity.programDataAddress.toBase58()} slot=${identity.deployedSlot.toString()} authority=${identity.upgradeAuthority?.toBase58() ?? "immutable"}`
          : `ProgramData=${identity.programDataAddress.toBase58()}`;
      appendStatus(
        true,
        `${program.binaryName} ${identity.mode} identity accepted at ${expected}; ${identityDetail}`,
        failures,
        warnings,
      );
    } catch (error) {
      appendStatus(
        false,
        `${program.binaryName} deployment identity rejected: ${error instanceof Error ? error.message : String(error)}`,
        failures,
        warnings,
      );
    }

    if (program.binaryName === "fight_oracle" && deploymentMode === "upgrade") {
      try {
        const oracleConfigAddress = deriveFightOracleConfigPda(programId);
        const oracleConfigAccount = await connection.getAccountInfo(
          oracleConfigAddress,
          "finalized",
        );
        const schema = evaluateFightOracleAccountSchema({
          programId,
          oracleConfigAccount,
        });
        appendStatus(
          true,
          schema.status === "current"
            ? `fight_oracle initialized account schema v${schema.schemaVersion} is upgrade-compatible`
            : "fight_oracle is deployed but uninitialized; no legacy duel state can exist",
          failures,
          warnings,
        );
      } catch (error) {
        appendStatus(
          false,
          `fight_oracle account schema rejected: ${error instanceof Error ? error.message : String(error)}`,
          failures,
          warnings,
        );
      }
    }

    const keypairPubkey = fs.existsSync(keypairPath)
      ? readKeypairPubkey(keypairPath)
      : null;
    if (deploymentMode === "fresh-deploy") {
      appendStatus(
        keypairPubkey === expected,
        `${program.binaryName} fresh-deploy keypair pubkey matches manifest (${expected})`,
        failures,
        warnings,
      );
    } else if (deploymentMode === "upgrade") {
      appendStatus(
        keypairPubkey === expected,
        `${program.binaryName} local program keypair matches manifest (${expected})`,
        failures,
        warnings,
        true,
      );
    }

    for (const [surface, idlPath] of [
      ["anchor", anchorIdlPath],
      ["app", appIdlPath],
      ["keeper", keeperIdlPath],
    ] as const) {
      const idlAddress = readIdlAddress(idlPath);
      appendStatus(
        idlAddress === expected,
        `${program.binaryName} ${surface} IDL matches manifest (${expected})`,
        failures,
        warnings,
      );
    }
  }

  if (warnings.length > 0) {
    console.log(`[preflight] warnings=${warnings.length}`);
  }
  if (failures.length > 0) {
    console.log(`[preflight] failures=${failures.length}`);
    process.exitCode = 1;
    return;
  }

  console.log("[preflight] all required Solana deployment checks passed");
}

void main().catch((error) => {
  console.error("[preflight] failed:", error);
  process.exitCode = 1;
});
