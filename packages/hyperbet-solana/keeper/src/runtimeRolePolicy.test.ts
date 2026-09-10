import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  assertDuelBotRuntimeRole,
  assertServiceRuntimeIsolation,
  isProtectedKeeperRuntimeEnvironment,
} from "./runtimeRolePolicy";

describe("production runtime role isolation", () => {
  test("the container entrypoint rejects a missing protected runtime role before process start", () => {
    const source = readFileSync(
      new URL("../start.sh", import.meta.url),
      "utf8",
    );
    expect(source).toContain("production|staging)");
    expect(source.indexOf('case "${NODE_ENV:-}" in')).toBeLessThan(
      source.indexOf(
        'export HYPERBET_RUNTIME_ROLE="${HYPERBET_RUNTIME_ROLE:-service}"',
      ),
    );
    expect(source.indexOf("HYPERBET_RUNTIME_ROLE is required")).toBeLessThan(
      source.indexOf(
        'export HYPERBET_RUNTIME_ROLE="${HYPERBET_RUNTIME_ROLE:-service}"',
      ),
    );
  });

  test("treats production and staging as the same protected runtime boundary", () => {
    for (const nodeEnv of ["production", "staging", " STAGING "]) {
      expect(isProtectedKeeperRuntimeEnvironment(nodeEnv)).toBe(true);
    }
    for (const nodeEnv of [undefined, "development", "test", "preview"]) {
      expect(isProtectedKeeperRuntimeEnvironment(nodeEnv)).toBe(false);
    }
  });

  test("keeps the public service free of every keeper signer", () => {
    expect(() =>
      assertServiceRuntimeIsolation({
        production: true,
        runtimeRole: "api",
        environment: {},
      }),
    ).toThrow("HYPERBET_RUNTIME_ROLE=service");
    expect(() =>
      assertServiceRuntimeIsolation({
        production: true,
        runtimeRole: "service",
        environment: { MARKET_MAKER_KEYPAIR: "[1,2,3]" },
      }),
    ).toThrow("MARKET_MAKER_KEYPAIR");
    expect(() =>
      assertServiceRuntimeIsolation({
        production: true,
        runtimeRole: "service",
        environment: { MARKET_MAKER_KEYPAIR: "   " },
      }),
    ).not.toThrow();
  });

  test("requires the dedicated duel-bot role on a protected runtime", () => {
    expect(() =>
      assertDuelBotRuntimeRole({ production: true, runtimeRole: "service" }),
    ).toThrow("HYPERBET_RUNTIME_ROLE=duel-bot");
    expect(() =>
      assertDuelBotRuntimeRole({
        production: true,
        runtimeRole: "duel-bot",
      }),
    ).not.toThrow();
    expect(() =>
      assertDuelBotRuntimeRole({ production: false, runtimeRole: undefined }),
    ).not.toThrow();
  });
});
