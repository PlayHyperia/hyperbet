import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createInitialOperatorAlertDurableState } from "./operatorAlertDispatcher";
import {
  loadOperatorAlertDurableState,
  persistOperatorAlertDurableState,
} from "./operatorAlertStateStore";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operator alert durable state store", () => {
  test("atomically creates and updates one owner-only validated state", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "operator-alert-state-"));
    directories.push(directory);
    const statePath = path.join(directory, "status", "alerts.json");
    const state = createInitialOperatorAlertDurableState("test.primary");

    persistOperatorAlertDurableState(statePath, state);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toEqual(state);

    state.telemetry.lastAttemptAtMs = 100;
    persistOperatorAlertDurableState(statePath, state);
    expect(
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toEqual(state);
    expect(readdirSync(path.dirname(statePath))).toEqual(["alerts.json"]);
  });

  test("rejects corrupt, oversized, route-drifted, and non-regular state", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "operator-alert-state-invalid-"),
    );
    directories.push(directory);
    const statePath = path.join(directory, "alerts.json");
    writeFileSync(statePath, "{not-json", { mode: 0o600 });
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toThrow("operator alert state file is invalid");

    writeFileSync(statePath, "x".repeat(64 * 1024 + 1));
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toThrow("operator alert state file is invalid");

    const valid = createInitialOperatorAlertDurableState("test.primary");
    writeFileSync(statePath, JSON.stringify(valid));
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "different.route",
      }),
    ).toThrow("operator alert state file is invalid");

    valid.telemetry.consecutiveFailures = 1;
    writeFileSync(statePath, JSON.stringify(valid));
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toThrow("operator alert state file is invalid");

    const ownerOnlyValid =
      createInitialOperatorAlertDurableState("test.primary");
    writeFileSync(statePath, JSON.stringify(ownerOnlyValid), { mode: 0o600 });
    chmodSync(statePath, 0o644);
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toThrow("operator alert state file is invalid");

    rmSync(statePath);
    mkdirSync(statePath);
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toThrow("operator alert state file is invalid");
    rmSync(statePath, { recursive: true });

    const symlinkTarget = path.join(directory, "symlink-target.json");
    writeFileSync(symlinkTarget, JSON.stringify(ownerOnlyValid), {
      mode: 0o600,
    });
    symlinkSync(symlinkTarget, statePath);
    expect(() =>
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toThrow("operator alert state file is invalid");
    rmSync(statePath);

    expect(
      loadOperatorAlertDurableState({
        statePath,
        routeId: "test.primary",
      }),
    ).toBeNull();
  });
});
