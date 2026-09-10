import { describe, expect, test } from "bun:test";

import { createKeeperBotHeartbeat } from "./botHeartbeat";

describe("keeper bot heartbeat", () => {
  test("rejects an interval that could churn RPC", () => {
    expect(() =>
      createKeeperBotHeartbeat({
        intervalMs: 249,
        probe: async () => undefined,
        onRpcSuccess: () => undefined,
        writeSnapshot: () => undefined,
      }),
    ).toThrow("at least 250ms");
  });

  test("permits one probe at a time and publishes one successful heartbeat", async () => {
    let releaseProbe!: () => void;
    let successes = 0;
    let snapshots = 0;
    const heartbeat = createKeeperBotHeartbeat({
      intervalMs: 250,
      probe: () => new Promise<void>((resolve) => (releaseProbe = resolve)),
      onRpcSuccess: () => (successes += 1),
      writeSnapshot: () => (snapshots += 1),
    });

    const first = heartbeat.tick();
    await Promise.resolve();
    expect(heartbeat.isProbeInFlight()).toBe(true);
    expect(await heartbeat.tick()).toBe(false);
    releaseProbe();
    expect(await first).toBe(true);
    expect({ successes, snapshots }).toEqual({ successes: 1, snapshots: 1 });

    heartbeat.stop();
    expect(await heartbeat.tick()).toBe(false);
  });

  test("records a failed probe without advancing RPC success", async () => {
    const errors: unknown[] = [];
    let snapshots = 0;
    const heartbeat = createKeeperBotHeartbeat({
      intervalMs: 250,
      probe: async () => {
        throw new Error("RPC unavailable");
      },
      onRpcSuccess: () => {
        throw new Error("must not advance");
      },
      writeSnapshot: () => (snapshots += 1),
      onProbeError: (error) => errors.push(error),
    });

    expect(await heartbeat.tick()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(snapshots).toBe(1);
  });
});
