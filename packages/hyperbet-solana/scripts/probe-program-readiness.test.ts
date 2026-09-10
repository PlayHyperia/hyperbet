import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Keypair } from "@solana/web3.js";

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "hyperbet-program-readiness-test-"),
);
const walletPath = path.join(temporaryDirectory, "wallet.json");
fs.writeFileSync(
  walletPath,
  `${JSON.stringify(Array.from(Keypair.generate().secretKey))}\n`,
  { mode: 0o600 },
);

const launchConfigurationEnvironmentNames = [
  "SOLANA_ORACLE_DISPUTE_WINDOW_SECS",
  "TRADE_TREASURY_FEE_BPS",
  "TRADE_MARKET_MAKER_FEE_BPS",
  "WINNINGS_MARKET_MAKER_FEE_BPS",
  "SOLANA_PM_REPORTER_PUBKEY",
  "SOLANA_PM_FINALIZER_PUBKEY",
  "SOLANA_PM_CHALLENGER_PUBKEY",
  "SOLANA_PM_MARKET_OPERATOR_PUBKEY",
  "SOLANA_PM_TREASURY_PUBKEY",
  "SOLANA_PM_MARKET_MAKER_PUBKEY",
] as const;

function cleanEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of launchConfigurationEnvironmentNames) {
    delete environment[name];
  }
  return environment;
}

function runProbe(args: string[]) {
  return Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dir, "probe-program-readiness.ts"),
      ...args,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: cleanEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

afterAll(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("Solana program readiness CLI", () => {
  test("documents the explicit configuration boundary without loading a wallet", () => {
    const result = runProbe(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("have no built-in defaults");
    expect(result.stderr.toString()).toBe("");
  });

  test("fails before RPC access when launch economics are absent", () => {
    const result = runProbe(["--wallet", walletPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "--oracle-dispute-window-secs or SOLANA_ORACLE_DISPUTE_WINDOW_SECS is required",
    );
  });

  test("fails before RPC access when launch roles are absent", () => {
    const result = runProbe([
      "--wallet",
      walletPath,
      "--oracle-dispute-window-secs",
      "73",
      "--trade-treasury-fee-bps",
      "11",
      "--trade-market-maker-fee-bps",
      "22",
      "--winnings-market-maker-fee-bps",
      "33",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "--reporter or SOLANA_PM_REPORTER_PUBKEY is required",
    );
  });
});
