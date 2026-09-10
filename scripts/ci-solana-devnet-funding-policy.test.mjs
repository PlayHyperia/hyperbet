import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseSolanaDevnetFundingPlan } from "./ci-solana-devnet-funding-policy.mjs";

const systemProgram = "11111111111111111111111111111111";
const wrappedSolMint = "So11111111111111111111111111111111111111112";
const scriptPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "ci-solana-devnet-funding-policy.mjs",
);

describe("Solana devnet funding policy", () => {
  test("normalizes unique recipients into exact lamports", () => {
    assert.deepEqual(
      parseSolanaDevnetFundingPlan(
        ` ${systemProgram}=0.000000001, ${wrappedSolMint}=10.000000000 `,
      ),
      {
        schemaVersion: 1,
        cluster: "devnet",
        asset: "SOL",
        atomicUnit: "lamports",
        recipients: [
          {
            address: systemProgram,
            amountSol: "0.000000001",
            amountLamports: "1",
          },
          {
            address: wrappedSolMint,
            amountSol: "10",
            amountLamports: "10000000000",
          },
        ],
        totalLamports: "10000000001",
      },
    );
  });

  test("rejects duplicate recipients before they can bypass the per-wallet cap", () => {
    assert.throws(
      () =>
        parseSolanaDevnetFundingPlan(
          `${systemProgram}=10,${systemProgram}=0.000000001`,
        ),
      /duplicates an earlier address/,
    );
  });

  test("rejects malformed addresses and ambiguous pairs", () => {
    for (const recipients of [
      "1111111111111111111111111111111=1",
      "111111111111111111111111111111111=1",
      "O11111111111111111111111111111111=1",
      `${systemProgram}==1`,
      `${systemProgram}=1=2`,
      `${systemProgram.slice(0, 16)} ${systemProgram.slice(16)}=1`,
      "",
    ]) {
      assert.throws(() => parseSolanaDevnetFundingPlan(recipients));
    }
  });

  test("rejects noncanonical, zero, over-cap, and over-precision amounts", () => {
    for (const amount of [
      "0",
      "00.1",
      ".1",
      "1.",
      "+1",
      "1e-9",
      "10.000000001",
      "11",
      "0.0000000001",
    ]) {
      assert.throws(() =>
        parseSolanaDevnetFundingPlan(`${systemProgram}=${amount}`),
      );
    }
  });

  test("enforces the existing twelve-recipient ceiling", () => {
    const thirteen = Array.from(
      { length: 13 },
      (_, index) => `${systemProgram}=${index + 1}`,
    ).join(",");
    assert.throws(
      () => parseSolanaDevnetFundingPlan(thirteen),
      /between 1 and 12/,
    );
  });

  test("CLI emits one machine-readable plan and rejects unknown options", () => {
    const accepted = spawnSync(
      process.execPath,
      [scriptPath, "--recipients", `${systemProgram}=1`],
      { encoding: "utf8" },
    );
    const rejected = spawnSync(process.execPath, [scriptPath, "--unknown"], {
      encoding: "utf8",
    });

    assert.equal(accepted.status, 0);
    assert.equal(JSON.parse(accepted.stdout).totalLamports, "1000000000");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Unknown funding-policy option/);
    assert.equal(rejected.stdout, "");
  });
});
