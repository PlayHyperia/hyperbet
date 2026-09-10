import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export type CaptureHarnessControl = {
  pidFile: string;
  cwd: string;
  runtime: string;
  streamStateUrl: string;
  rendererStatusPath: string | null;
  capturePort: number;
  captureBrowserPort: number;
};
type ProcessEntry = {
  pid: number;
  parentPid: number;
  groupId: number;
  command: string;
};
type Ancestor = Omit<ProcessEntry, "command">;
type CaptureWorker = {
  capturePort: number;
  listenerPid: number | null;
  groupId: number;
  leaderPid: number;
  memberPids: number[];
};
type HlsSnapshot = {
  urlSha256: string;
  mediaSequence: number;
  segmentCount: number;
  lastSegmentSha256: string;
  lastProgramDateTimeMs: number;
  targetDurationSeconds: number;
};
type WarmRenderer = {
  pid: number;
  groupId: number;
  targetId: string;
  pageUrlSha256: string;
  timeOrigin: number;
  navigationEntries: number;
  hasCanvas: boolean;
  rendererReady: boolean;
};
type RendererSnapshot = {
  updatedAt: number;
  healthUpdatedAt: number;
  ready: boolean;
  degradedReason: string | null;
  ffmpegRunning: boolean;
  bytesReceived: number;
  audioSource: string;
  audioHealthy: boolean;
  audioChunks: number;
  audioLastChunkAt: number;
  contextState: string;
  sourceContextState: string;
  trackState: string;
  contentChunks: number;
  captureTargetFps: number;
  captureMeasuredFps: number;
  captureEmittedFrames: number;
  lifecycle: {
    processId: number;
    processStartedAt: number;
    stage: string;
    transitions: Array<{ stage: string; at: number }>;
  };
};
export type CaptureRuntimeSnapshot = {
  observedAt: number;
  rootPid: number;
  rootGroupId: number;
  rootCommandSha256: string;
  topologySha256: string;
  verifierPid: number;
  verifierGroupId: number;
  worker: CaptureWorker;
  workerAncestors: Ancestor[];
  warmAncestors: Ancestor[];
  warm: WarmRenderer;
  renderer: RendererSnapshot;
  previousHls: HlsSnapshot;
  hls: HlsSnapshot;
};
type RestartPolicy = {
  parseProcessSnapshot(raw: string): Array<Omit<ProcessEntry, "parentPid">>;
  parseListenerPids(raw: string): number[];
  validateCaptureRestartTarget(input: {
    capturePort: number;
    listenerPids: number[];
    processSnapshot: Array<Omit<ProcessEntry, "parentPid">>;
    verifierPid: number;
  }): CaptureWorker;
};

const execute = promisify(execFile);
const FRESHNESS_MS = 15_000;
const LIFECYCLE_STAGES = [
  "process_starting",
  "bridge_starting",
  "browser_launching",
  "renderer_waiting",
  "renderer_ready",
  "capture_warmup",
  "capture_starting",
  "streaming",
];
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
function fail(field: string): never {
  throw new Error(`Capture authority evidence invalid: ${field}`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(field);
}
function positive(value: unknown, field: string): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fail(field);
}
function integer(value: unknown, field: string, minimum = 1): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : fail(field);
}
function string(value: unknown, field: string): string {
  return typeof value === "string" && value.length > 0 ? value : fail(field);
}
function hash(value: unknown, field: string): string {
  const result = string(value, field);
  return /^[a-f0-9]{64}$/.test(result) ? result : fail(field);
}
function fresh(value: unknown, observedAt: number, field: string): number {
  const at = positive(value, field);
  return at <= observedAt && observedAt - at <= FRESHNESS_MS ? at : fail(field);
}

export function assertCaptureLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("loopback URL");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    fail("loopback URL");
  }
  return url;
}
function option(command: string, name: string): string {
  const matches = [
    ...command.matchAll(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\S+)`, "g")),
  ];
  return matches.length === 1 ? matches[0][1] : fail(`root --${name}`);
}

/** Bind the observed browser to this root's exact client, API and capture ports. */
export function assertCaptureTopology(
  control: CaptureHarnessControl,
  rootCommand: string,
  pageUrl?: string,
): void {
  if (
    control.runtime !== "full_3d" ||
    !path.isAbsolute(control.pidFile) ||
    !path.isAbsolute(control.cwd) ||
    !control.rendererStatusPath ||
    !path.isAbsolute(control.rendererStatusPath)
  )
    fail("full_3d harness paths");
  for (const port of [control.capturePort, control.captureBrowserPort]) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      fail("capture port");
  }
  if (
    control.capturePort === control.captureBrowserPort ||
    !/(?:^|\s)(?:\S*\/)?scripts\/duel-stack\.mjs(?:\s|$)/.test(rootCommand)
  )
    fail("duel-stack root");
  const stream = assertCaptureLoopbackUrl(control.streamStateUrl);
  const server = assertCaptureLoopbackUrl(option(rootCommand, "server-url"));
  const client = assertCaptureLoopbackUrl(option(rootCommand, "client-url"));
  if (
    stream.pathname !== "/api/streaming/state" ||
    stream.origin !== server.origin ||
    Number(option(rootCommand, "rtmp-port")) !== control.capturePort ||
    Number(option(rootCommand, "capture-browser-port")) !==
      control.captureBrowserPort
  )
    fail("root topology");
  if (pageUrl !== undefined) {
    const page = assertCaptureLoopbackUrl(pageUrl);
    if (page.origin !== client.origin || page.pathname !== "/stream.html")
      fail("warm page topology");
  }
}

function assertAncestry(
  value: unknown,
  startPid: number,
  rootPid: number,
  rootGroupId: number,
  field: string,
): Ancestor[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64)
    return fail(field);
  const rows = value.map((entry) => {
    const row = record(entry, field);
    return {
      pid: integer(row.pid, field, 2),
      parentPid: integer(row.parentPid, field),
      groupId: integer(row.groupId, field, 2),
    };
  });
  if (
    rows[0].pid !== startPid ||
    rows.at(-1)?.pid !== rootPid ||
    rows.at(-1)?.groupId !== rootGroupId ||
    new Set(rows.map((row) => row.pid)).size !== rows.length ||
    rows.some(
      (row, index) =>
        index < rows.length - 1 && row.parentPid !== rows[index + 1].pid,
    )
  )
    fail(field);
  return rows;
}

function parseHls(value: unknown): HlsSnapshot {
  const row = record(value, "HLS");
  return {
    urlSha256: hash(row.urlSha256, "HLS URL identity"),
    mediaSequence: integer(row.mediaSequence, "HLS sequence", 0),
    segmentCount: integer(row.segmentCount, "HLS segments"),
    lastSegmentSha256: hash(row.lastSegmentSha256, "HLS segment identity"),
    lastProgramDateTimeMs: positive(
      row.lastProgramDateTimeMs,
      "HLS program date",
    ),
    targetDurationSeconds: positive(
      row.targetDurationSeconds,
      "HLS target duration",
    ),
  };
}
function assertHlsAdvanced(before: HlsSnapshot, after: HlsSnapshot): void {
  if (
    before.urlSha256 !== after.urlSha256 ||
    before.lastSegmentSha256 === after.lastSegmentSha256 ||
    after.mediaSequence + after.segmentCount <=
      before.mediaSequence + before.segmentCount ||
    after.lastProgramDateTimeMs <= before.lastProgramDateTimeMs
  )
    fail("HLS did not advance");
}

function parseRenderer(
  value: unknown,
  observedAt: number,
  worker: CaptureWorker,
): RendererSnapshot {
  const row = record(value, "renderer");
  if (
    row.ready !== true ||
    row.degradedReason !== null ||
    row.ffmpegRunning !== true ||
    row.audioSource !== "browser" ||
    row.audioHealthy !== true ||
    row.contextState !== "running" ||
    row.sourceContextState !== "running" ||
    row.trackState !== "live"
  )
    fail("renderer video/audio readiness");
  const rawLifecycle = record(row.lifecycle, "capture lifecycle");
  const processId = integer(rawLifecycle.processId, "lifecycle process", 2);
  const processStartedAt = positive(
    rawLifecycle.processStartedAt,
    "lifecycle start",
  );
  if (
    !worker.memberPids.includes(processId) ||
    processStartedAt > observedAt ||
    rawLifecycle.stage !== "streaming" ||
    !Array.isArray(rawLifecycle.transitions)
  )
    fail("capture lifecycle");
  const expectedStages =
    rawLifecycle.transitions.length === LIFECYCLE_STAGES.length - 1
      ? LIFECYCLE_STAGES.filter((stage) => stage !== "capture_warmup")
      : LIFECYCLE_STAGES;
  if (rawLifecycle.transitions.length !== expectedStages.length)
    fail("capture lifecycle length");
  let lastAt = processStartedAt;
  const transitions = rawLifecycle.transitions.map((entry, index) => {
    const transition = record(entry, "lifecycle transition");
    const at = positive(transition.at, "lifecycle transition timestamp");
    if (
      transition.stage !== expectedStages[index] ||
      at < lastAt ||
      at > observedAt ||
      (index === 0 && at !== processStartedAt)
    )
      fail("lifecycle transition order");
    lastAt = at;
    return { stage: expectedStages[index], at };
  });
  return {
    updatedAt: fresh(row.updatedAt, observedAt, "renderer status age"),
    healthUpdatedAt: fresh(
      row.healthUpdatedAt,
      observedAt,
      "renderer health age",
    ),
    ready: true,
    degradedReason: null,
    ffmpegRunning: true,
    bytesReceived: integer(row.bytesReceived, "video bytes"),
    audioSource: "browser",
    audioHealthy: true,
    audioChunks: integer(row.audioChunks, "audio chunks"),
    audioLastChunkAt: fresh(row.audioLastChunkAt, observedAt, "audio age"),
    contextState: "running",
    sourceContextState: "running",
    trackState: "live",
    contentChunks: integer(row.contentChunks, "audio content chunks"),
    captureTargetFps: positive(row.captureTargetFps, "capture target fps"),
    captureMeasuredFps: positive(
      row.captureMeasuredFps,
      "capture measured fps",
    ),
    captureEmittedFrames: integer(row.captureEmittedFrames, "capture frames"),
    lifecycle: { processId, processStartedAt, stage: "streaming", transitions },
  };
}

function parseSnapshot(value: unknown): CaptureRuntimeSnapshot {
  const row = record(value, "snapshot");
  const observedAt = positive(row.observedAt, "observation time");
  const rootPid = integer(row.rootPid, "root PID", 2);
  const rootGroupId = integer(row.rootGroupId, "root group", 2);
  const verifierPid = integer(row.verifierPid, "verifier PID", 2);
  const verifierGroupId = integer(row.verifierGroupId, "verifier group", 2);
  const rawWorker = record(row.worker, "worker");
  if (!Array.isArray(rawWorker.memberPids)) fail("worker members");
  const memberPids = rawWorker.memberPids.map((pid) =>
    integer(pid, "worker member", 2),
  );
  const worker: CaptureWorker = {
    capturePort: integer(rawWorker.capturePort, "capture port"),
    listenerPid:
      rawWorker.listenerPid === null
        ? null
        : integer(rawWorker.listenerPid, "capture listener", 2),
    groupId: integer(rawWorker.groupId, "capture group", 2),
    leaderPid: integer(rawWorker.leaderPid, "capture leader", 2),
    memberPids,
  };
  const rawWarm = record(row.warm, "warm renderer");
  const warm: WarmRenderer = {
    pid: integer(rawWarm.pid, "warm PID", 2),
    groupId: integer(rawWarm.groupId, "warm group", 2),
    targetId: string(rawWarm.targetId, "warm target"),
    pageUrlSha256: hash(rawWarm.pageUrlSha256, "warm URL identity"),
    timeOrigin: positive(rawWarm.timeOrigin, "warm time origin"),
    navigationEntries: integer(rawWarm.navigationEntries, "warm navigations"),
    hasCanvas: rawWarm.hasCanvas === true,
    rendererReady: rawWarm.rendererReady === true,
  };
  if (
    worker.capturePort > 65_535 ||
    worker.leaderPid !== worker.groupId ||
    memberPids.length < 1 ||
    new Set(memberPids).size !== memberPids.length ||
    !memberPids.includes(worker.leaderPid) ||
    (worker.listenerPid !== null && !memberPids.includes(worker.listenerPid)) ||
    [rootPid, verifierPid, warm.pid].some((pid) => memberPids.includes(pid)) ||
    [rootGroupId, verifierGroupId, warm.groupId].includes(worker.groupId) ||
    !warm.hasCanvas ||
    !warm.rendererReady ||
    warm.timeOrigin > observedAt
  )
    fail("isolated capture ownership/readiness");
  const workerAncestors = assertAncestry(
    row.workerAncestors,
    worker.leaderPid,
    rootPid,
    rootGroupId,
    "worker ancestry",
  );
  const warmAncestors = assertAncestry(
    row.warmAncestors,
    warm.pid,
    rootPid,
    rootGroupId,
    "warm ancestry",
  );
  if (
    workerAncestors[0].groupId !== worker.groupId ||
    warmAncestors[0].groupId !== warm.groupId ||
    warmAncestors.some((ancestor) => memberPids.includes(ancestor.pid))
  )
    fail("capture/warm ancestry isolation");
  const previousHls = parseHls(row.previousHls);
  const hls = parseHls(row.hls);
  assertHlsAdvanced(previousHls, hls);
  fresh(hls.lastProgramDateTimeMs, observedAt, "HLS age");
  return {
    observedAt,
    rootPid,
    rootGroupId,
    verifierPid,
    verifierGroupId,
    rootCommandSha256: hash(row.rootCommandSha256, "root command identity"),
    topologySha256: hash(row.topologySha256, "topology identity"),
    worker,
    workerAncestors,
    warmAncestors,
    warm,
    renderer: parseRenderer(row.renderer, observedAt, worker),
    previousHls,
    hls,
  };
}

export function assertCaptureRecovery(
  before: CaptureRuntimeSnapshot,
  after: CaptureRuntimeSnapshot,
): void {
  const initial = parseSnapshot(before);
  const recovered = parseSnapshot(after);
  for (const field of [
    "rootPid",
    "rootGroupId",
    "rootCommandSha256",
    "topologySha256",
    "verifierPid",
    "verifierGroupId",
  ] as const) {
    if (initial[field] !== recovered[field]) fail(`changed ${field}`);
  }
  for (const field of [
    "pid",
    "groupId",
    "targetId",
    "pageUrlSha256",
    "timeOrigin",
    "navigationEntries",
  ] as const) {
    if (initial.warm[field] !== recovered.warm[field])
      fail(`changed warm ${field}`);
  }
  if (
    recovered.observedAt <= initial.observedAt ||
    recovered.worker.capturePort !== initial.worker.capturePort ||
    recovered.worker.groupId === initial.worker.groupId ||
    (initial.worker.listenerPid !== null &&
      recovered.worker.listenerPid === initial.worker.listenerPid) ||
    recovered.worker.memberPids.some((pid) =>
      initial.worker.memberPids.includes(pid),
    ) ||
    recovered.renderer.lifecycle.processStartedAt <= initial.observedAt
  )
    fail("capture process replacement");
  assertHlsAdvanced(initial.hls, recovered.hls);
}

export function assertCaptureFaultEvidence(value: unknown): void {
  const row = record(value, "fault");
  const killedAt = positive(row.killedAt, "kill timestamp");
  const before = parseSnapshot(row.before);
  const after = parseSnapshot(row.after);
  assertCaptureRecovery(before, after);
  if (
    killedAt < before.observedAt ||
    killedAt >= after.observedAt ||
    after.renderer.lifecycle.processStartedAt <= killedAt
  )
    fail("replacement after kill");
  for (const field of ["apiFailClosedAt", "browserFailClosedAt"] as const) {
    const at = positive(row[field], field);
    if (at < killedAt || at - killedAt > 5_000 || at >= after.observedAt)
      fail(field);
  }
}

async function run(command: string, args: string[]): Promise<string> {
  try {
    return (
      await execute(command, args, {
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error(`Capture ownership ${command} inspection failed`);
  }
}
/** CDP pipes frames directly; only its unused legacy capture port may be absent. */
export function captureListenerInspectionOutput(
  result: { exitCode: unknown; stdout: unknown; stderr: unknown },
  allowAbsent: boolean,
): string {
  if (
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    result.stderr !== ""
  )
    fail("listener inspection output");
  if (result.exitCode === 0) return result.stdout;
  if (allowAbsent && result.exitCode === 1 && result.stdout === "") return "";
  return fail("listener inspection exit");
}
async function listenerPids(
  port: number,
  policy: RestartPolicy,
  allowAbsent = false,
): Promise<number[]> {
  let result: { exitCode: unknown; stdout: unknown; stderr: unknown };
  try {
    const output = await execute(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
    );
    result = { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    const failure = record(error, "listener inspection failure");
    result = {
      exitCode: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
  return policy.parseListenerPids(
    captureListenerInspectionOutput(result, allowAbsent),
  );
}
function ancestry(
  rows: ProcessEntry[],
  pid: number,
  rootPid: number,
): Ancestor[] {
  const result: Ancestor[] = [];
  let currentPid = pid;
  while (result.length < 64) {
    const row = rows.find((candidate) => candidate.pid === currentPid);
    if (!row || result.some((entry) => entry.pid === row.pid))
      return fail("live process ancestry");
    result.push({
      pid: row.pid,
      parentPid: row.parentPid,
      groupId: row.groupId,
    });
    if (row.pid === rootPid) return result;
    currentPid = row.parentPid;
  }
  return fail("live process ancestry bound");
}
async function readOwnership(control: CaptureHarnessControl) {
  if (
    control.runtime !== "full_3d" ||
    !path.isAbsolute(control.pidFile) ||
    !path.isAbsolute(control.cwd) ||
    !control.rendererStatusPath ||
    !path.isAbsolute(control.rendererStatusPath)
  )
    fail("full_3d harness paths");
  // Import the existing destructive-action guard; this test must not fork its rules.
  const policy = (await import(
    pathToFileURL(
      path.join(control.cwd, "scripts/duel-capture-restart-policy.mjs"),
    ).href
  )) as RestartPolicy;
  const rootPid = integer(
    Number(
      (
        await readFile(control.pidFile, {
          encoding: "utf8",
          signal: AbortSignal.timeout(5_000),
        })
      ).trim(),
    ),
    "live root PID",
    2,
  );
  const [rawProcesses, captureListeners, warmListeners, rawCwd] =
    await Promise.all([
      run("ps", ["-axo", "pid=,ppid=,pgid=,command="]),
      listenerPids(control.capturePort, policy, true),
      listenerPids(control.captureBrowserPort, policy),
      run("lsof", ["-a", "-p", String(rootPid), "-d", "cwd", "-Fn"]),
    ]);
  const rows = rawProcesses.split(/\r?\n/).flatMap((line): ProcessEntry[] => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            groupId: Number(match[3]),
            command: match[4],
          },
        ]
      : [];
  });
  const root = rows.find((entry) => entry.pid === rootPid);
  const verifier = rows.find((entry) => entry.pid === process.pid);
  if (
    !root ||
    !verifier ||
    captureListeners.length > 1 ||
    warmListeners.length !== 1
  )
    fail("live root/listeners");
  assertCaptureTopology(control, root.command);
  const cwdLines = rawCwd.split(/\r?\n/).filter((line) => line.startsWith("n"));
  if (
    cwdLines.length !== 1 ||
    (await realpath(cwdLines[0].slice(1))) !== (await realpath(control.cwd))
  )
    fail("root working directory");
  const worker = policy.validateCaptureRestartTarget({
    capturePort: control.capturePort,
    listenerPids: captureListeners,
    processSnapshot: policy.parseProcessSnapshot(
      rows.map((row) => `${row.pid} ${row.groupId} ${row.command}`).join("\n"),
    ),
    verifierPid: process.pid,
  });
  const warm = rows.find((entry) => entry.pid === warmListeners[0]);
  if (
    !warm ||
    !warm.command.includes("Google Chrome") ||
    warm.command.includes("--headless") ||
    !warm.command.includes("--use-angle=metal") ||
    !warm.command.includes(
      `--remote-debugging-port=${control.captureBrowserPort}`,
    )
  )
    fail("owned headful Metal Chrome");
  const workerAncestors = ancestry(rows, worker.leaderPid, rootPid);
  const warmAncestors = ancestry(rows, warm.pid, rootPid);
  if (
    !warmAncestors.some((entry) =>
      rows
        .find((candidate) => candidate.pid === entry.pid)
        ?.command.includes("scripts/capture-browser-host.ts"),
    )
  )
    fail("warm browser host ownership");
  if (
    [root.groupId, verifier.groupId, warm.groupId].includes(worker.groupId) ||
    [root.pid, verifier.pid, warm.pid].some((pid) =>
      worker.memberPids.includes(pid),
    ) ||
    warmAncestors.some((entry) => worker.memberPids.includes(entry.pid))
  )
    fail("unsafe worker group");
  return { root, verifier, worker, warm, workerAncestors, warmAncestors };
}

async function fetchText(url: string): Promise<string> {
  assertCaptureLoopbackUrl(url);
  const response = await fetch(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Capture evidence HTTP ${response.status}`);
  return response.text();
}
async function evaluateCdpTarget(webSocketUrl: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let settled = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error("Warm renderer CDP timed out")),
      5_000,
    );
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: `(() => { const health = globalThis.__HYPERIA_STREAM_RENDERER_HEALTH__; return { pageUrl: location.href, timeOrigin: performance.timeOrigin, navigationEntries: performance.getEntriesByType("navigation").length, hasCanvas: document.querySelector("canvas") !== null, rendererReady: health?.ready === true && health?.degradedReason == null }; })()`,
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      ),
    );
    socket.addEventListener("message", (event) => {
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(String(event.data)), "CDP response");
      } catch {
        return;
      }
      if (message.id !== 1) return;
      try {
        const result = record(message.result, "CDP result");
        if (message.error || result.exceptionDetails)
          throw new Error("CDP evaluation failed");
        finish(null, record(result.result, "CDP value").value);
      } catch {
        finish(new Error("Warm renderer CDP evaluation failed"));
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error("Warm renderer CDP connection failed")),
    );
    socket.addEventListener("close", () =>
      finish(new Error("Warm renderer CDP closed before observation")),
    );
  });
}
async function readWarm(
  control: CaptureHarnessControl,
  owner: Awaited<ReturnType<typeof readOwnership>>,
): Promise<WarmRenderer> {
  const targets: unknown = JSON.parse(
    await fetchText(`http://127.0.0.1:${control.captureBrowserPort}/json/list`),
  );
  if (!Array.isArray(targets)) fail("CDP target list");
  const pages = targets
    .map((target) => record(target, "CDP target"))
    .filter((target) => target.type === "page");
  if (pages.length !== 1) fail("unique warm page");
  const target = pages[0];
  const pageUrl = string(target.url, "CDP page URL");
  assertCaptureTopology(control, owner.root.command, pageUrl);
  const socketUrl = new URL(string(target.webSocketDebuggerUrl, "CDP socket"));
  if (
    socketUrl.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(socketUrl.hostname) ||
    socketUrl.port !== String(control.captureBrowserPort) ||
    socketUrl.username ||
    socketUrl.password ||
    socketUrl.search ||
    socketUrl.hash ||
    socketUrl.pathname !==
      `/devtools/page/${string(target.id, "CDP target ID")}`
  )
    fail("owned CDP socket");
  const evaluated = record(
    await evaluateCdpTarget(socketUrl.href),
    "warm page observation",
  );
  if (evaluated.pageUrl !== pageUrl) fail("warm runtime URL identity");
  return {
    pid: owner.warm.pid,
    groupId: owner.warm.groupId,
    targetId: string(target.id, "warm target"),
    pageUrlSha256: sha256(pageUrl),
    timeOrigin: positive(evaluated.timeOrigin, "warm time origin"),
    navigationEntries: integer(evaluated.navigationEntries, "warm navigations"),
    hasCanvas: evaluated.hasCanvas === true,
    rendererReady: evaluated.rendererReady === true,
  };
}

async function readHls(url: string): Promise<HlsSnapshot> {
  if (!assertCaptureLoopbackUrl(url).pathname.endsWith(".m3u8"))
    fail("HLS playlist URL");
  const lines = (await fetchText(url))
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines[0] !== "#EXTM3U" || lines.includes("#EXT-X-ENDLIST"))
    fail("live HLS playlist");
  const sequences = lines.filter((line) =>
    /^#EXT-X-MEDIA-SEQUENCE:\d+$/.test(line),
  );
  const targets = lines.filter((line) =>
    /^#EXT-X-TARGETDURATION:\d+$/.test(line),
  );
  const segments = lines.filter((line) => line && !line.startsWith("#"));
  const dates = lines
    .filter((line) => line.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))
    .map((line) => Date.parse(line.slice(25)));
  if (
    sequences.length !== 1 ||
    targets.length !== 1 ||
    segments.length < 1 ||
    dates.length !== segments.length ||
    dates.some((at) => !Number.isFinite(at))
  )
    fail("HLS media playlist");
  for (const segment of segments) {
    const segmentUrl = assertCaptureLoopbackUrl(new URL(segment, url).href);
    if (
      segmentUrl.origin !== new URL(url).origin ||
      !/\.(?:ts|m4s|mp4)$/.test(segmentUrl.pathname)
    )
      fail("owned HLS segment");
  }
  return parseHls({
    urlSha256: sha256(url),
    mediaSequence: Number(sequences[0].split(":")[1]),
    segmentCount: segments.length,
    lastSegmentSha256: sha256(segments.at(-1) ?? ""),
    lastProgramDateTimeMs: dates.at(-1),
    targetDurationSeconds: Number(targets[0].split(":")[1]),
  });
}

export async function readOwnedCaptureSnapshot(
  control: CaptureHarnessControl,
  hlsUrl: string,
): Promise<CaptureRuntimeSnapshot> {
  const previousHls = await readHls(hlsUrl);
  let hls = previousHls;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    hls = await readHls(hlsUrl);
    try {
      assertHlsAdvanced(previousHls, hls);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assertHlsAdvanced(previousHls, hls);
  const owner = await readOwnership(control);
  const warm = await readWarm(control, owner);
  if (!control.rendererStatusPath) fail("renderer status path");
  const raw = record(
    JSON.parse(
      await readFile(control.rendererStatusPath, {
        encoding: "utf8",
        signal: AbortSignal.timeout(5_000),
      }),
    ),
    "renderer status",
  );
  if (raw.source !== "external-rtmp-bridge" || raw.captureMode !== "cdp")
    fail("actual external CDP renderer status");
  const health = record(raw.rendererHealth, "renderer health");
  const stats = record(raw.stats, "capture stats");
  const audio = record(raw.browserAudioCaptureHealth, "browser audio");
  const capture = record(raw.captureHealth, "capture health");
  return parseSnapshot({
    observedAt: Date.now(),
    rootPid: owner.root.pid,
    rootGroupId: owner.root.groupId,
    verifierPid: owner.verifier.pid,
    verifierGroupId: owner.verifier.groupId,
    rootCommandSha256: sha256(owner.root.command),
    topologySha256: sha256(JSON.stringify(control)),
    worker: owner.worker,
    workerAncestors: owner.workerAncestors,
    warmAncestors: owner.warmAncestors,
    warm,
    renderer: {
      updatedAt: raw.updatedAt,
      healthUpdatedAt: health.updatedAt,
      ready: health.ready,
      degradedReason: health.degradedReason ?? null,
      ffmpegRunning: stats.ffmpegRunning,
      bytesReceived: stats.bytesReceived,
      audioSource: stats.audioSource,
      audioHealthy: stats.audioHealthy,
      audioChunks: stats.audioChunks,
      audioLastChunkAt: stats.audioLastChunkAt,
      contextState: audio.contextState,
      sourceContextState: audio.sourceContextState,
      trackState: audio.trackState,
      contentChunks: audio.contentChunks,
      captureTargetFps: capture.targetFps,
      captureMeasuredFps: capture.measuredFps,
      captureEmittedFrames: capture.emittedFrames,
      lifecycle: raw.captureLifecycle,
    },
    previousHls,
    hls,
  });
}

export async function killOwnedCaptureWorker(
  control: CaptureHarnessControl,
  before: CaptureRuntimeSnapshot,
): Promise<number> {
  const baseline = parseSnapshot(before);
  if (
    Date.now() - baseline.observedAt > 15_000 ||
    Date.now() < baseline.observedAt ||
    sha256(JSON.stringify(control)) !== baseline.topologySha256
  )
    fail("stale kill authorization");
  const owner = await readOwnership(control);
  const warm = await readWarm(control, owner);
  if (
    owner.root.pid !== baseline.rootPid ||
    sha256(owner.root.command) !== baseline.rootCommandSha256 ||
    owner.worker.groupId !== baseline.worker.groupId ||
    owner.worker.listenerPid !== baseline.worker.listenerPid ||
    JSON.stringify([...owner.worker.memberPids].sort((a, b) => a - b)) !==
      JSON.stringify([...baseline.worker.memberPids].sort((a, b) => a - b)) ||
    JSON.stringify(warm) !== JSON.stringify(baseline.warm)
  )
    fail("kill target changed since review");
  // Last ownership check follows CDP I/O. No signals go to the root or warm renderer.
  const current = await readOwnership(control);
  if (
    current.root.pid !== owner.root.pid ||
    current.root.command !== owner.root.command ||
    current.worker.groupId !== owner.worker.groupId ||
    current.worker.listenerPid !== owner.worker.listenerPid ||
    current.warm.pid !== owner.warm.pid ||
    JSON.stringify(current.worker.memberPids) !==
      JSON.stringify(owner.worker.memberPids)
  )
    fail("kill target changed during revalidation");
  const killedAt = Date.now();
  process.kill(-current.worker.groupId, "SIGKILL");
  return killedAt;
}
