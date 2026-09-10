import { describe, expect, test } from "bun:test";
import {
  assertCaptureFaultEvidence,
  assertCaptureLoopbackUrl,
  assertCaptureRecovery,
  assertCaptureTopology,
  captureListenerInspectionOutput,
  type CaptureHarnessControl,
  type CaptureRuntimeSnapshot,
} from "../e2e/wagerAuthorityCapture";

const stages = [
  "process_starting",
  "bridge_starting",
  "browser_launching",
  "renderer_waiting",
  "renderer_ready",
  "capture_warmup",
  "capture_starting",
  "streaming",
];
const origin = 1_800_000_000_000;
function snapshot(replacement: boolean): CaptureRuntimeSnapshot {
  const workerPid = replacement ? 600 : 300;
  const observedAt = origin + (replacement ? 30_000 : 10_000);
  const startAt = origin + (replacement ? 12_000 : 1_000);
  const sequence = replacement ? 10 : 2;
  return {
    observedAt,
    rootPid: 100,
    rootGroupId: 100,
    rootCommandSha256: "a".repeat(64),
    topologySha256: "b".repeat(64),
    verifierPid: 200,
    verifierGroupId: 200,
    worker: {
      capturePort: 35803,
      listenerPid: workerPid + 1,
      groupId: workerPid,
      leaderPid: workerPid,
      memberPids: [workerPid, workerPid + 1],
    },
    workerAncestors: [
      { pid: workerPid, parentPid: 100, groupId: workerPid },
      { pid: 100, parentPid: 50, groupId: 100 },
    ],
    warmAncestors: [
      { pid: 401, parentPid: 400, groupId: 400 },
      { pid: 400, parentPid: 100, groupId: 400 },
      { pid: 100, parentPid: 50, groupId: 100 },
    ],
    warm: {
      pid: 401,
      groupId: 400,
      targetId: "warm-target",
      pageUrlSha256: "c".repeat(64),
      timeOrigin: origin,
      navigationEntries: 1,
      hasCanvas: true,
      rendererReady: true,
    },
    renderer: {
      updatedAt: observedAt - 100,
      healthUpdatedAt: observedAt - 100,
      ready: true,
      degradedReason: null,
      ffmpegRunning: true,
      bytesReceived: 1024,
      audioSource: "browser",
      audioHealthy: true,
      audioChunks: 20,
      audioLastChunkAt: observedAt - 100,
      contextState: "running",
      sourceContextState: "running",
      trackState: "live",
      contentChunks: 5,
      captureTargetFps: 30,
      captureMeasuredFps: 30,
      captureEmittedFrames: 60,
      lifecycle: {
        processId: workerPid + 1,
        processStartedAt: startAt,
        stage: "streaming",
        transitions: stages.map((stage, index) => ({
          stage,
          at: startAt + index * 100,
        })),
      },
    },
    previousHls: {
      urlSha256: "d".repeat(64),
      mediaSequence: sequence - 1,
      segmentCount: 3,
      lastSegmentSha256: "e".repeat(64),
      lastProgramDateTimeMs: observedAt - 5_000,
      targetDurationSeconds: 2,
    },
    hls: {
      urlSha256: "d".repeat(64),
      mediaSequence: sequence,
      segmentCount: 3,
      lastSegmentSha256: (replacement ? "f" : "1").repeat(64),
      lastProgramDateTimeMs: observedAt - 3_000,
      targetDurationSeconds: 2,
    },
  };
}
function evidence() {
  return {
    killedAt: origin + 11_000,
    apiFailClosedAt: origin + 11_500,
    browserFailClosedAt: origin + 12_000,
    before: snapshot(false),
    after: snapshot(true),
  };
}

describe("actual capture fault evidence policy", () => {
  test("accepts an isolated replacement with the same warm renderer and advancing audio/video", () => {
    const value = evidence();
    expect(() => assertCaptureFaultEvidence(value)).not.toThrow();
    expect(() =>
      assertCaptureRecovery(value.before, value.after),
    ).not.toThrow();
    value.after.renderer.lifecycle.transitions =
      value.after.renderer.lifecycle.transitions.filter(
        (entry) => entry.stage !== "capture_warmup",
      );
    expect(() => assertCaptureFaultEvidence(value)).not.toThrow();
  });

  test("allows an explicitly absent legacy listener without weakening process ownership", () => {
    const value = evidence();
    value.before.worker.listenerPid = null;
    value.after.worker.listenerPid = null;
    expect(() => assertCaptureFaultEvidence(value)).not.toThrow();
    for (const invalid of [
      undefined,
      "",
      0,
      1,
      -1,
      999,
      value.after.rootPid,
      value.after.warm.pid,
      value.after.verifierPid,
    ]) {
      expect(() =>
        assertCaptureFaultEvidence({
          ...value,
          after: {
            ...value.after,
            worker: { ...value.after.worker, listenerPid: invalid },
          },
        }),
      ).toThrow();
    }
    value.after.workerAncestors[0].parentPid = 999;
    expect(() => assertCaptureFaultEvidence(value)).toThrow();
    value.after.workerAncestors[0].parentPid = value.after.rootPid;
    value.after.renderer.lifecycle.processId = 999;
    expect(() => assertCaptureFaultEvidence(value)).toThrow();
  });

  test("treats only capture-port lsof exit one with strictly empty output as absence", () => {
    expect(
      captureListenerInspectionOutput(
        { exitCode: 1, stdout: "", stderr: "" },
        true,
      ),
    ).toBe("");
    expect(
      captureListenerInspectionOutput(
        { exitCode: 0, stdout: "301\n", stderr: "" },
        false,
      ),
    ).toBe("301\n");
    for (const result of [
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "301\n", stderr: "" },
      { exitCode: 1, stdout: "\n", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "\n" },
      { exitCode: 1, stdout: "", stderr: "inspection denied" },
      { exitCode: 2, stdout: "", stderr: "" },
      { exitCode: "ENOENT", stdout: "", stderr: "" },
      { exitCode: "1", stdout: "", stderr: "" },
      { exitCode: null, stdout: "", stderr: "" },
      { exitCode: undefined, stdout: "", stderr: "" },
      { exitCode: 1, stdout: undefined, stderr: "" },
      { exitCode: 1, stdout: "", stderr: undefined },
    ]) {
      expect(() => captureListenerInspectionOutput(result, false)).toThrow();
      if (result.exitCode !== 1 || result.stdout !== "" || result.stderr !== "")
        expect(() => captureListenerInspectionOutput(result, true)).toThrow();
    }
  });

  test("rejects every missing required snapshot and lifecycle field", () => {
    for (const side of ["before", "after"] as const) {
      const baseline = evidence();
      const paths = [
        ...Object.keys(baseline[side]).map((key) => [key]),
        ...Object.keys(baseline[side].worker).map((key) => ["worker", key]),
        ...Object.keys(baseline[side].warm).map((key) => ["warm", key]),
        ...Object.keys(baseline[side].renderer).map((key) => ["renderer", key]),
        ...Object.keys(baseline[side].renderer.lifecycle).map((key) => [
          "renderer",
          "lifecycle",
          key,
        ]),
        ...Object.keys(baseline[side].hls).map((key) => ["hls", key]),
        ...Object.keys(baseline[side].previousHls).map((key) => [
          "previousHls",
          key,
        ]),
      ];
      for (const fieldPath of paths) {
        const value = evidence();
        let object = value[side] as unknown as Record<string, unknown>;
        for (const key of fieldPath.slice(0, -1))
          object = object[key] as Record<string, unknown>;
        delete object[fieldPath.at(-1) ?? ""];
        expect(
          () => assertCaptureFaultEvidence(value),
          `${side}.${fieldPath.join(".")}`,
        ).toThrow();
      }
    }
  });

  test("rejects altered or dangerous process ownership and warm-page replacement", () => {
    const mutations: Array<(value: ReturnType<typeof evidence>) => void> = [
      (v) => {
        v.after.rootPid = 101;
      },
      (v) => {
        v.after.rootGroupId = 101;
      },
      (v) => {
        v.after.rootCommandSha256 = "f".repeat(64);
      },
      (v) => {
        v.after.topologySha256 = "f".repeat(64);
      },
      (v) => {
        v.after.verifierPid = 201;
      },
      (v) => {
        v.after.verifierGroupId = 201;
      },
      (v) => {
        v.after.worker = { ...v.before.worker };
      },
      (v) => {
        v.after.worker.capturePort += 1;
      },
      (v) => {
        v.after.worker.memberPids.push(v.before.worker.memberPids[1]);
      },
      (v) => {
        v.after.worker.memberPids.push(v.after.rootPid);
      },
      (v) => {
        v.after.worker.memberPids.push(v.after.verifierPid);
      },
      (v) => {
        v.after.worker.memberPids.push(v.after.warm.pid);
      },
      (v) => {
        v.after.worker.groupId = v.after.rootGroupId;
      },
      (v) => {
        v.after.worker.groupId = v.after.verifierGroupId;
      },
      (v) => {
        v.after.worker.groupId = v.after.warm.groupId;
      },
      (v) => {
        v.after.worker.leaderPid += 1;
      },
      (v) => {
        v.after.worker.listenerPid = v.after.worker.memberPids[1] + 100;
      },
      (v) => {
        v.after.worker.memberPids.push(v.after.worker.memberPids[1]);
      },
      (v) => {
        v.after.workerAncestors[0].parentPid = 500;
      },
      (v) => {
        v.after.workerAncestors[0].groupId = 500;
      },
      (v) => {
        v.after.warmAncestors[0].parentPid = 500;
      },
      (v) => {
        v.after.warmAncestors[0].groupId = 500;
      },
      (v) => {
        v.after.warmAncestors[1].pid = v.after.worker.leaderPid;
      },
      (v) => {
        v.after.warm.pid += 1;
      },
      (v) => {
        v.after.warm.groupId += 1;
      },
      (v) => {
        v.after.warm.targetId = "replaced-target";
      },
      (v) => {
        v.after.warm.pageUrlSha256 = "f".repeat(64);
      },
      (v) => {
        v.after.warm.timeOrigin += 1;
      },
      (v) => {
        v.after.warm.navigationEntries += 1;
      },
      (v) => {
        v.after.warm.hasCanvas = false;
      },
      (v) => {
        v.after.warm.rendererReady = false;
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const value = evidence();
      mutate(value);
      expect(
        () => assertCaptureFaultEvidence(value),
        `ownership mutation ${index}`,
      ).toThrow();
    }
  });

  test("rejects stale/absent renderer, lifecycle, audio and HLS evidence", () => {
    const mutations: Array<(value: ReturnType<typeof evidence>) => void> = [
      (v) => {
        v.after.renderer.ready = false;
      },
      (v) => {
        v.after.renderer.degradedReason = "capture_process_exited";
      },
      (v) => {
        v.after.renderer.updatedAt -= 20_000;
      },
      (v) => {
        v.after.renderer.healthUpdatedAt += 1_000;
      },
      (v) => {
        v.after.renderer.ffmpegRunning = false;
      },
      (v) => {
        v.after.renderer.bytesReceived = 0;
      },
      (v) => {
        v.after.renderer.audioHealthy = false;
      },
      (v) => {
        v.after.renderer.audioSource = "silent";
      },
      (v) => {
        v.after.renderer.audioChunks = 0;
      },
      (v) => {
        v.after.renderer.audioLastChunkAt -= 20_000;
      },
      (v) => {
        v.after.renderer.contextState = "suspended";
      },
      (v) => {
        v.after.renderer.sourceContextState = "closed";
      },
      (v) => {
        v.after.renderer.trackState = "ended";
      },
      (v) => {
        v.after.renderer.contentChunks = 0;
      },
      (v) => {
        v.after.renderer.captureTargetFps = 0;
      },
      (v) => {
        v.after.renderer.captureMeasuredFps = 0;
      },
      (v) => {
        v.after.renderer.captureEmittedFrames = 0;
      },
      (v) => {
        v.after.renderer.lifecycle.processId = 999;
      },
      (v) => {
        v.after.renderer.lifecycle.stage = "renderer_waiting";
      },
      (v) => {
        v.after.renderer.lifecycle.processStartedAt = v.killedAt;
      },
      (v) => {
        v.after.renderer.lifecycle.transitions[0].at -= 1;
      },
      (v) => {
        v.after.renderer.lifecycle.transitions[2].at = origin;
      },
      (v) => {
        v.after.renderer.lifecycle.transitions[2].stage = "page_loading";
      },
      (v) => {
        v.after.renderer.lifecycle.transitions.pop();
      },
      (v) => {
        v.after.hls = { ...v.after.previousHls };
      },
      (v) => {
        v.after.hls.lastSegmentSha256 = v.after.previousHls.lastSegmentSha256;
      },
      (v) => {
        v.after.hls.urlSha256 = "f".repeat(64);
      },
      (v) => {
        v.after.hls.mediaSequence = 0;
      },
      (v) => {
        v.after.hls.segmentCount = 0;
      },
      (v) => {
        v.after.hls.lastProgramDateTimeMs =
          v.after.previousHls.lastProgramDateTimeMs;
      },
      (v) => {
        v.after.hls.lastProgramDateTimeMs = v.after.observedAt - 30_000;
      },
      (v) => {
        v.after.hls.targetDurationSeconds = 0;
      },
      (v) => {
        v.after.previousHls = { ...v.before.previousHls };
        v.after.hls = { ...v.before.hls };
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const value = evidence();
      mutate(value);
      expect(
        () => assertCaptureFaultEvidence(value),
        `health mutation ${index}`,
      ).toThrow();
    }
  });

  test("fails closed for missing, reversed or late kill and revocation timestamps", () => {
    for (const key of [
      "killedAt",
      "apiFailClosedAt",
      "browserFailClosedAt",
    ] as const) {
      for (const value of [
        undefined,
        null,
        "1",
        NaN,
        Infinity,
        0,
        -1,
        origin,
        origin + 40_000,
      ]) {
        expect(() =>
          assertCaptureFaultEvidence({ ...evidence(), [key]: value }),
        ).toThrow();
      }
    }
    for (const key of ["apiFailClosedAt", "browserFailClosedAt"] as const) {
      const value = evidence();
      value[key] = value.killedAt + 5_001;
      expect(() => assertCaptureFaultEvidence(value)).toThrow();
      value[key] = value.killedAt + 5_000;
      expect(() => assertCaptureFaultEvidence(value)).not.toThrow();
    }
    for (const invalid of [null, [], {}, true])
      expect(() => assertCaptureFaultEvidence(invalid)).toThrow();
  });
});

describe("local capture topology policy", () => {
  const control: CaptureHarnessControl = {
    pidFile: "/private/tmp/owned.pid",
    cwd: "/workspace/hyperia",
    runtime: "full_3d",
    streamStateUrl: "http://127.0.0.1:35800/api/streaming/state",
    rendererStatusPath: "/private/tmp/rtmp-status.json",
    capturePort: 35803,
    captureBrowserPort: 35804,
  };
  const command =
    "/usr/local/bin/node scripts/duel-stack.mjs --server-url http://127.0.0.1:35800 --client-url http://127.0.0.1:35801 --rtmp-port 35803 --capture-browser-port 35804";
  test("binds the live stream page to the exact root topology without retaining its fragment", () => {
    expect(() =>
      assertCaptureTopology(
        control,
        command,
        "http://127.0.0.1:35801/stream.html?stream=true#local-test-only",
      ),
    ).not.toThrow();
    expect(() =>
      assertCaptureTopology(
        control,
        command.replace("--rtmp-port 35803", "--rtmp-port=35803"),
      ),
    ).not.toThrow();
  });
  test("rejects remote, deceptive, credentialed, wrong-owner or wrong-page targets", () => {
    for (const url of [
      "https://127.0.0.1/stream.html",
      "http://127.0.0.1.evil.invalid/stream.html",
      "http://example.invalid/stream.html",
      "file:///tmp/stream.html",
      "ws://localhost/",
      "http://user:password@localhost/",
      "not a URL",
    ])
      expect(() => assertCaptureLoopbackUrl(url)).toThrow();
    for (const page of [
      "http://127.0.0.1:35802/stream.html",
      "http://localhost:35801/stream.html",
      "http://127.0.0.1:35801/",
      "http://127.0.0.1:35801/index.html",
    ])
      expect(() => assertCaptureTopology(control, command, page)).toThrow();
    for (const altered of [
      command.replace("duel-stack.mjs", "another-stack.mjs"),
      command.replace("35800", "35900"),
      command.replace("--rtmp-port 35803", "--rtmp-port 35500"),
      command.replace(
        "--capture-browser-port 35804",
        "--capture-browser-port 35501",
      ),
      `${command} --client-url http://127.0.0.1:35801`,
    ])
      expect(() => assertCaptureTopology(control, altered)).toThrow();
    for (const altered of [
      { ...control, runtime: "synthetic" },
      { ...control, cwd: "relative" },
      { ...control, pidFile: "relative" },
      { ...control, rendererStatusPath: null },
      { ...control, captureBrowserPort: control.capturePort },
      { ...control, capturePort: 65_536 },
      { ...control, streamStateUrl: "http://127.0.0.1:35800/api/health" },
    ])
      expect(() => assertCaptureTopology(altered, command)).toThrow();
  });
});
