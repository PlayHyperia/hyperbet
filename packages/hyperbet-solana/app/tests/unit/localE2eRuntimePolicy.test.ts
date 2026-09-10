import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  isHeadlessWalletRuntimeAllowed,
  LOCAL_E2E_WALLET_APPROVAL,
  requestLocalE2eWalletSignatureApproval,
} from "../../src/lib/headlessWallet";
import {
  assertWagerAuthorityBrowserReport,
  assertCaptureWagerAuthorityBrowserReport,
  CAPTURE_WAGER_AUTHORITY_BOUNDARIES,
  captureWagerAuthorityTestTitle,
  WAGER_AUTHORITY_BOUNDARIES,
  wagerAuthorityTestTitle,
} from "../e2e/wagerAuthorityEvidence";
import { buildWagerAuthorityFixtureUpdate } from "../e2e/wagerAuthorityFixture";

const harnessSource = readFileSync(
  fileURLToPath(new URL("../../scripts/run-e2e-local.sh", import.meta.url)),
  "utf8",
);
const marketFlowsSource = readFileSync(
  fileURLToPath(new URL("../e2e/market-flows.e2e.ts", import.meta.url)),
  "utf8",
);
const processControlSource = readFileSync(
  fileURLToPath(
    new URL("../../../../../scripts/e2e-process-control.sh", import.meta.url),
  ),
  "utf8",
);
describe("local Solana E2E runtime policy", () => {
  test("authority runs require an explicit existing wallet path without configured-wallet fallback", () => {
    const start = harnessSource.indexOf("resolve_localnet_wallet_path() {");
    const end = harnessSource.indexOf(
      "resolve_localnet_mint_authority() {",
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const resolver = harnessSource.slice(start, end);
    for (const matrix of ["synthetic", "capture"]) {
      const invoke = (walletPath: string) =>
        spawnSync(
          "bash",
          ["-ceu", `${resolver}\nresolve_localnet_wallet_path`],
          {
            encoding: "utf8",
            timeout: 5_000,
            env: {
              ...process.env,
              E2E_WAGER_AUTHORITY_MATRIX: String(matrix === "synthetic"),
              E2E_CAPTURE_WAGER_AUTHORITY_MATRIX: String(matrix === "capture"),
              E2E_SOLANA_BOOTSTRAP_KEYPAIR: walletPath,
            },
          },
        );
      for (const missing of [
        "",
        "relative-wallet.json",
        "/dev/null/missing.json",
      ]) {
        const result = invoke(missing);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "configured wallet fallback is forbidden",
        );
      }
      // This exercises path resolution only, never parses or signs with key material.
      const existing = fileURLToPath(import.meta.url);
      const accepted = invoke(existing);
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toBe(`${existing}\n`);
      expect(accepted.stderr).toBe("");
    }
  });

  test("publishes new fixture events without replaying a stale source cursor", () => {
    const cycle = {
      cycleId: "cycle-a",
      duelId: "duel-a",
      duelKeyHex: "a".repeat(64),
      phase: "ANNOUNCEMENT",
      competitiveSnapshotDigest: "b".repeat(64),
      competitiveSnapshot: { snapshotVersion: 4, persisted: true },
      betCloseTime: 1_800_000_600_000,
      rendererHealth: { ready: true, updatedAt: 1_800_000_000_000 },
    };
    const source = {
      seq: 12,
      sourceEpoch: 1,
      phaseVersion: 12,
      emittedAt: 1_800_000_000_000,
      type: "STREAMING_STATE_UPDATE",
      cycle,
      leaderboard: [],
      cameraTarget: null,
      preparation: null,
    };
    const unavailable = buildWagerAuthorityFixtureUpdate(
      source,
      { rendererHealth: { ready: false, updatedAt: 1_800_000_001_000 } },
      1_800_000_001_000,
    );
    const terminal = buildWagerAuthorityFixtureUpdate(
      source,
      { phase: "RESOLUTION", outcome: "cancelled" },
      1_800_000_002_000,
    );
    for (const update of [unavailable, terminal]) {
      expect(Object.keys(update).sort()).toEqual([
        "cameraTarget",
        "cycle",
        "emittedAt",
        "leaderboard",
        "preparation",
      ]);
      expect(update.cycle.competitiveSnapshot).toBe(cycle.competitiveSnapshot);
      expect(update.cycle.competitiveSnapshotDigest).toBe(
        cycle.competitiveSnapshotDigest,
      );
      expect(update.cycle.duelKeyHex).toBe(cycle.duelKeyHex);
      expect(update.cycle.betCloseTime).toBe(cycle.betCloseTime);
      expect(update.emittedAt).toBeGreaterThan(source.emittedAt);
    }
    expect(unavailable.cycle.rendererHealth).toEqual({
      ready: false,
      updatedAt: 1_800_000_001_000,
    });
    expect(terminal.cycle.phase).toBe("RESOLUTION");
    expect(source.cycle.phase).toBe("ANNOUNCEMENT");
    expect(source.cycle.rendererHealth.ready).toBe(true);
    for (const timestamp of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
    ]) {
      expect(() =>
        buildWagerAuthorityFixtureUpdate(source, {}, timestamp),
      ).toThrow();
    }
  });

  test("typechecks the real browser entry before taking ownership of runtime ports", () => {
    const typecheck = harnessSource.indexOf(
      'bun run --cwd "$APP_DIR" typecheck:e2e:wager-authority',
    );
    expect(typecheck).toBeGreaterThan(0);
    expect(typecheck).toBeLessThan(
      harnessSource.indexOf('\nkill_listeners "$APP_PORT"'),
    );
    expect(
      harnessSource.indexOf("E2E_RUNTIME_OWNERSHIP_STARTED=0"),
    ).toBeLessThan(harnessSource.indexOf("trap cleanup EXIT"));
    expect(
      harnessSource.indexOf("E2E_RUNTIME_OWNERSHIP_STARTED=1"),
    ).toBeGreaterThan(harnessSource.indexOf('\nkill_listeners "$APP_PORT"'));
    expect(
      harnessSource.includes(
        'if [[ "$E2E_RUNTIME_OWNERSHIP_STARTED" != "1" ]]; then\n    cleanup_cargo_target\n    trap - EXIT\n    exit "$exit_code"',
      ),
    ).toBe(true);
    expect(
      harnessSource.includes("authority verification refuses occupied port"),
    ).toBe(true);
    expect(
      harnessSource.includes(
        "authority verification requires fresh ledger and keeper database paths",
      ),
    ).toBe(true);
    expect(
      harnessSource.includes(
        "authority verification refuses existing runtime ownership file",
      ),
    ).toBe(true);
    const reusedRuntimeAttestation = harnessSource.indexOf(
      "verifying reused competitive runtime before creating the launch database",
    );
    expect(reusedRuntimeAttestation).toBeGreaterThan(0);
    expect(reusedRuntimeAttestation).toBeLessThan(
      harnessSource.indexOf("docker run --rm -d"),
    );
    expect(
      harnessSource.includes(
        "import { verifyCompetitiveServerRuntime } from './packages/server/dist/competitiveServerBootstrap.js'",
      ),
    ).toBe(true);
  });

  test("selects all authority stages from Playwright's qualified titles", () => {
    const selector = harnessSource.match(
      /WAGER_AUTHORITY_REPORT_ARGS=\(--reporter=list,json --grep '([^']+)'\)/,
    )?.[1];
    expect(selector).toBeDefined();
    if (!selector) throw new Error("Authority matrix selector is missing");
    const pattern = new RegExp(selector);
    for (const boundary of WAGER_AUTHORITY_BOUNDARIES) {
      expect(
        pattern.test(
          `chromium solana-clob-ui.e2e.ts ${wagerAuthorityTestTitle(boundary)}`,
        ),
      ).toBe(true);
    }
    expect(pattern.test("unrelated passing test")).toBe(false);
    expect(pattern.test(wagerAuthorityTestTitle("substitute"))).toBe(false);
    expect(
      pattern.test(`${wagerAuthorityTestTitle("review")} substitute`),
    ).toBe(false);
  });

  test("requires all four browser authority stages with no skips, retries, or substitute tests", () => {
    const makeEvidence = (
      boundary: (typeof WAGER_AUTHORITY_BOUNDARIES)[number],
    ) => {
      const signature = "1".repeat(64);
      const existingSignature = "2".repeat(64);
      return {
        schemaVersion: 2,
        boundary,
        source: "synthetic_publish",
        externalValue: false,
        runtime: "production_preview_e2e_mode",
        realRendererFault: false,
        realWalletSigning: true,
        genesis: "3".repeat(44),
        wallet: "4".repeat(44),
        duelId: "1777777777777",
        duelKey: "a".repeat(64),
        market: "5".repeat(44),
        competitiveSnapshotDigest: "b".repeat(64),
        signature,
        beforeChain: {
          lamports: 100_000,
          signatures: [existingSignature],
        },
        afterChain: {
          lamports: 90_000,
          signatures: [signature, existingSignature],
        },
        sends: 1,
        records: 1,
        successfulRecords: 1,
        trackingAttempts: [
          {
            status: 200,
            payload: {
              chainKey: "solana",
              chain: "SOLANA",
              sourceAsset: "SOL",
              sourceAmountLamports: "50000000",
              bettorWallet: "4".repeat(44),
              txSignature: signature,
              externalBetRef: `solana:${signature}`,
              marketRef: "5".repeat(44),
              marketPda: "5".repeat(44),
              duelId: "1777777777777",
              duelKey: "a".repeat(64),
            },
          },
        ],
        walletRequests: boundary === "wallet" ? 2 : 1,
        feeLamports: 5_000,
        walletDebitLamports: 10_000,
        finalizedAccountConservation: true,
      };
    };
    const makeReport = () => ({
      config: {
        projects: [{ name: "chromium", retries: 0, repeatEach: 1 }],
      },
      stats: { expected: 4, skipped: 0, unexpected: 0, flaky: 0 },
      errors: [],
      suites: [
        {
          specs: WAGER_AUTHORITY_BOUNDARIES.map((boundary) => ({
            title: wagerAuthorityTestTitle(boundary),
            file: "solana-clob-ui.e2e.ts",
            id: `chromium-${boundary}`,
            ok: true,
            tests: [
              {
                status: "expected",
                expectedStatus: "passed",
                projectName: "chromium",
                results: [
                  {
                    status: "passed",
                    retry: 0,
                    errors: [] as unknown[],
                    attachments: [
                      {
                        name: "wager-authority-evidence",
                        contentType: "application/json",
                        body: Buffer.from(
                          JSON.stringify(makeEvidence(boundary)),
                        ).toString("base64"),
                      },
                    ],
                  },
                ],
              },
            ],
          })),
        },
      ],
    });
    expect(() => assertWagerAuthorityBrowserReport(makeReport())).not.toThrow();
    expect(() =>
      assertCaptureWagerAuthorityBrowserReport(makeReport()),
    ).toThrow();
    const relabeledSynthetic = makeReport();
    relabeledSynthetic.stats.expected = 2;
    relabeledSynthetic.suites[0].specs = relabeledSynthetic.suites[0].specs
      .filter((spec) =>
        [
          wagerAuthorityTestTitle("wallet"),
          wagerAuthorityTestTitle("broadcast"),
        ].includes(spec.title),
      )
      .map((spec, index) => ({
        ...spec,
        title: captureWagerAuthorityTestTitle(
          CAPTURE_WAGER_AUTHORITY_BOUNDARIES[index],
        ),
      }));
    expect(() =>
      assertCaptureWagerAuthorityBrowserReport(relabeledSynthetic),
    ).toThrow(/claims are invalid/);
    for (const spec of relabeledSynthetic.suites[0].specs) {
      const attachment = spec.tests[0].results[0].attachments[0];
      const evidence = JSON.parse(
        Buffer.from(attachment.body, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      evidence.source = "real_hyperia";
      evidence.realCaptureFault = true;
      attachment.body = Buffer.from(JSON.stringify(evidence)).toString(
        "base64",
      );
    }
    expect(() =>
      assertCaptureWagerAuthorityBrowserReport(relabeledSynthetic),
    ).toThrow();
    const retryReport = makeReport();
    const retryAttachment =
      retryReport.suites[0].specs[0].tests[0].results[0].attachments[0];
    const retryEvidence = makeEvidence("review");
    retryEvidence.trackingAttempts.unshift(
      { ...retryEvidence.trackingAttempts[0], status: 425 },
      { ...retryEvidence.trackingAttempts[0], status: 503 },
    );
    retryEvidence.records = 3;
    retryAttachment.body = Buffer.from(JSON.stringify(retryEvidence)).toString(
      "base64",
    );
    expect(() => assertWagerAuthorityBrowserReport(retryReport)).not.toThrow();
    for (const field of ["skipped", "unexpected", "flaky"] as const) {
      const report = makeReport();
      report.stats[field] = 1;
      expect(() => assertWagerAuthorityBrowserReport(report)).toThrow();
    }
    for (const mutation of [
      "omitted",
      "duplicate",
      "retried",
      "skipped",
      "substitute",
    ]) {
      const report = makeReport();
      const spec = report.suites[0].specs[0];
      if (mutation === "omitted") report.suites[0].specs.pop();
      if (mutation === "duplicate") report.suites[0].specs.push(spec);
      if (mutation === "retried")
        spec.tests[0].results.push(spec.tests[0].results[0]);
      if (mutation === "skipped") spec.tests[0].results[0].status = "skipped";
      if (mutation === "substitute") spec.title = "unrelated passing test";
      expect(() => assertWagerAuthorityBrowserReport(report)).toThrow();
    }
    for (const mutate of [
      (report: ReturnType<typeof makeReport>) => {
        report.config.projects[0].name = "webkit";
      },
      (report: ReturnType<typeof makeReport>) => {
        report.config.projects[0].retries = 1;
      },
      (report: ReturnType<typeof makeReport>) => {
        report.config.projects[0].repeatEach = 2;
      },
      (report: ReturnType<typeof makeReport>) => {
        report.suites[0].specs[0].file = "substitute.e2e.ts";
      },
      (report: ReturnType<typeof makeReport>) => {
        report.suites[0].specs[1].id = report.suites[0].specs[0].id;
      },
      (report: ReturnType<typeof makeReport>) => {
        report.suites[0].specs[0].tests[0].expectedStatus = "failed";
      },
      (report: ReturnType<typeof makeReport>) => {
        report.suites[0].specs[0].tests[0].results[0].retry = 1;
      },
      (report: ReturnType<typeof makeReport>) => {
        report.suites[0].specs[0].tests[0].results[0].errors.push({});
      },
      (report: ReturnType<typeof makeReport>) => {
        report.suites[0].specs[0].tests[0].results[0].attachments.length = 0;
      },
      (report: ReturnType<typeof makeReport>) => {
        const attachments =
          report.suites[0].specs[0].tests[0].results[0].attachments;
        attachments.push(attachments[0]);
      },
    ]) {
      const report = makeReport();
      mutate(report);
      expect(() => assertWagerAuthorityBrowserReport(report)).toThrow();
    }
    const mutateEvidence = (
      mutation: (evidence: Record<string, unknown>) => void,
    ) => {
      const report = makeReport();
      const attachment =
        report.suites[0].specs[0].tests[0].results[0].attachments[0];
      const evidence = JSON.parse(
        Buffer.from(attachment.body, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      mutation(evidence);
      attachment.body = Buffer.from(JSON.stringify(evidence)).toString(
        "base64",
      );
      expect(() => assertWagerAuthorityBrowserReport(report)).toThrow();
    };
    for (const [field, value] of [
      ["boundary", "broadcast"],
      ["externalValue", true],
      ["realRendererFault", true],
      ["realCaptureFault", true],
      ["realWalletSigning", false],
      ["sends", 0],
      ["records", 0],
      ["successfulRecords", 0],
      ["walletRequests", 2],
      ["finalizedAccountConservation", false],
      ["signature", "invalid"],
    ] as const) {
      mutateEvidence((evidence) => {
        evidence[field] = value;
      });
    }
    mutateEvidence((evidence) => {
      const after = evidence.afterChain as Record<string, unknown>;
      after.signatures = [];
    });
    mutateEvidence((evidence) => {
      evidence.walletDebitLamports = 9_999;
    });
    for (const mutation of [
      "missing",
      "unbounded",
      "unresolved",
      "duplicate-success",
      "wrong-signature",
      "changed-market",
      "unexpected-failure",
    ]) {
      mutateEvidence((evidence) => {
        const attempts = evidence.trackingAttempts as ReturnType<
          typeof makeEvidence
        >["trackingAttempts"];
        if (mutation === "missing") attempts.length = 0;
        if (mutation === "unbounded") {
          while (attempts.length < 129)
            attempts.unshift({ ...attempts[0], status: 425 });
        }
        if (mutation === "unresolved") attempts[0].status = 425;
        if (mutation === "duplicate-success")
          attempts.unshift({ ...attempts[0] });
        if (mutation === "wrong-signature")
          attempts[0].payload.txSignature = "2".repeat(64);
        if (mutation === "changed-market")
          attempts.unshift({
            status: 425,
            payload: { ...attempts[0].payload, marketRef: "6".repeat(44) },
          });
        if (mutation === "unexpected-failure")
          attempts.unshift({ ...attempts[0], status: 400 });
        evidence.records = attempts.length;
      });
    }
    expect(harnessSource).toContain(
      "WAGER_AUTHORITY_REPORT_ARGS=(--reporter=list,json --grep",
    );
    expect(harnessSource).toContain("export E2E_PLAYWRIGHT_RETRIES=0");
    expect(
      harnessSource.includes(
        "validate(JSON.parse(readFileSync(process.argv[2], 'utf8')))",
      ),
    ).toBe(true);
    expect(
      harnessSource.includes(
        "realCapture ? policy.assertCaptureWagerAuthorityBrowserReport : policy.assertWagerAuthorityBrowserReport",
      ),
    ).toBe(true);
    expect(harnessSource).toContain(
      "wager authority matrix requires production_preview",
    );
    expect(harnessSource).toContain(
      'mktemp "$APP_DIR/.e2e-wager-authority-report.XXXXXX"',
    );
  });

  test("selects only actual wallet and broadcast capture failures for the full-3D gate", () => {
    const selectors = [
      ...harnessSource.matchAll(
        /WAGER_AUTHORITY_REPORT_ARGS=\(--reporter=list,json --grep '([^']+)'\)/g,
      ),
    ].map((entry) => new RegExp(entry[1]));
    expect(selectors).toHaveLength(2);
    for (const boundary of CAPTURE_WAGER_AUTHORITY_BOUNDARIES) {
      const title = `chromium solana-clob-ui.e2e.ts ${captureWagerAuthorityTestTitle(boundary)}`;
      expect(selectors[0].test(title)).toBe(false);
      expect(selectors[1].test(title)).toBe(true);
    }
    for (const boundary of WAGER_AUTHORITY_BOUNDARIES) {
      expect(selectors[1].test(wagerAuthorityTestTitle(boundary))).toBe(false);
    }
    expect(selectors[1].test(captureWagerAuthorityTestTitle("review"))).toBe(
      false,
    );
    expect(
      selectors[1].test(`${captureWagerAuthorityTestTitle("wallet")} omitted`),
    ).toBe(false);
  });

  test("counts real approval requests and releases only the matching pending one", async () => {
    GlobalRegistrator.register({ url: "http://127.0.0.1" });
    const events = new EventTarget();
    const storage = window.sessionStorage;
    const keys = LOCAL_E2E_WALLET_APPROVAL;
    const input = { mode: "e2e", hostname: "127.0.0.1", storage, events };
    try {
      await requestLocalE2eWalletSignatureApproval(input);
      expect(storage.getItem(keys.requests)).toBe("1");
      storage.setItem(keys.pauseNext, "1");
      let released = false;
      const approval = requestLocalE2eWalletSignatureApproval(input).then(
        () => {
          released = true;
        },
      );
      expect(storage.getItem(keys.requests)).toBe("2");
      expect(storage.getItem(keys.pending)).toBe("2");
      expect(storage.getItem(keys.pauseNext)).toBeNull();
      events.dispatchEvent(new CustomEvent(keys.releaseEvent, { detail: "1" }));
      await Promise.resolve();
      expect(released).toBe(false);
      events.dispatchEvent(new CustomEvent(keys.releaseEvent, { detail: "2" }));
      await approval;
      expect(released).toBe(true);
      expect(storage.getItem(keys.pending)).toBeNull();
      await requestLocalE2eWalletSignatureApproval(input);
      expect(storage.getItem(keys.requests)).toBe("3");
      storage.setItem(keys.pauseNext, "1");
      const cancelled = requestLocalE2eWalletSignatureApproval(input);
      events.dispatchEvent(new CustomEvent(keys.cancelEvent, { detail: "4" }));
      await expect(cancelled).rejects.toThrow("approval cancelled");
      expect(storage.getItem(keys.pending)).toBeNull();
    } finally {
      GlobalRegistrator.unregister();
    }
  });

  test("never auto-approves on timeout and leaves controls inert outside local e2e", async () => {
    GlobalRegistrator.register({ url: "http://127.0.0.1" });
    const events = new EventTarget();
    const storage = window.sessionStorage;
    const keys = LOCAL_E2E_WALLET_APPROVAL;
    const input = { mode: "e2e", hostname: "127.0.0.1", storage, events };
    try {
      storage.setItem(keys.pauseNext, "1");
      await expect(
        requestLocalE2eWalletSignatureApproval({ ...input, timeoutMs: 5 }),
      ).rejects.toThrow("approval timed out");
      expect(storage.getItem(keys.pending)).toBeNull();
      expect(storage.getItem(keys.requests)).toBe("1");
      storage.setItem(keys.pauseNext, "1");
      for (const runtime of [
        { mode: "production", hostname: "127.0.0.1" },
        { mode: "e2e", hostname: "hyperbet.example" },
      ]) {
        await requestLocalE2eWalletSignatureApproval({ ...input, ...runtime });
        expect(storage.getItem(keys.requests)).toBe("1");
        expect(storage.getItem(keys.pauseNext)).toBe("1");
        expect(storage.getItem(keys.pending)).toBeNull();
      }
      storage.setItem(keys.requests, "invalid");
      await expect(
        requestLocalE2eWalletSignatureApproval(input),
      ).rejects.toThrow("counter is invalid");
    } finally {
      GlobalRegistrator.unregister();
    }
  });

  test("permits embedded test wallets only in e2e mode on exact loopback hosts", () => {
    for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
      expect(isHeadlessWalletRuntimeAllowed({ mode: "e2e", hostname })).toBe(
        true,
      );
    }

    for (const hostname of [
      "hyperbet.example",
      "127.0.0.1.example",
      "192.168.1.20",
      "0.0.0.0",
      "",
    ]) {
      expect(isHeadlessWalletRuntimeAllowed({ mode: "e2e", hostname })).toBe(
        false,
      );
    }

    expect(
      isHeadlessWalletRuntimeAllowed({
        mode: "production",
        hostname: "localhost",
      }),
    ).toBe(false);
    expect(
      isHeadlessWalletRuntimeAllowed({ mode: "e2e", hostname: null }),
    ).toBe(false);
  });

  test("pins setup to Node 22 and makes production transaction authority explicit", () => {
    expect(harnessSource).toContain('E2E_NODE_BIN="$(resolve_node_22_bin');
    expect(harnessSource).toContain(
      '"$E2E_NODE_BIN" --import tsx "$APP_DIR/tests/e2e/setup-localnet.ts"',
    );
    expect(harnessSource).toContain('--arg launchPath "$PATH"');
    expect(harnessSource).toContain("launchPath: $launchPath");
    expect(harnessSource).toContain(
      'hyperia_start_command+=" --reuse-game-builds"',
    );
    expect(harnessSource).toContain(
      'pidStrategy: (if $hyperiaRuntime == "full_3d" then "root" else "listener" end)',
    );
    expect(processControlSource).toContain(
      `launch_path="$(jq -r '.launchPath // empty' "$CONTROL_PATH")"`,
    );
    expect(processControlSource).toContain(
      "control launchPath entries must be absolute",
    );
    expect(processControlSource).toContain(
      "service pidStrategy must be root or listener",
    );
    expect(processControlSource).toContain(
      'if [[ "$pid_strategy" == "listener" ]]',
    );
    expect(processControlSource).not.toContain("bash -lc");
    expect(processControlSource).not.toContain("/Users/mac/.bun/bin");
    expect(marketFlowsSource).toContain("const resolvedLaunchNodePath =");
    expect(marketFlowsSource).toContain(
      "fs.realpathSync(resolvedLaunchNodePath)",
    );
    expect(marketFlowsSource).toContain("fs.realpathSync(configuredNodePath)");
    expect(marketFlowsSource).toContain(
      'expect(reuseGameBuilds).toBe(process.env.E2E_SKIP_PREBUILD === "true")',
    );
    expect(marketFlowsSource).toContain(
      'restartedProcessCommand.includes("--reuse-game-builds")',
    );
    expect(marketFlowsSource).toContain('status: "temporarily_unavailable"');
    expect(marketFlowsSource).toContain(
      'error.message === "Hyperia authority health returned HTTP 503"',
    );
    expect(
      processControlSource.match(
        /\/usr\/bin\/nohup \/usr\/bin\/env PATH="\$launch_path" \/bin\/bash -c/g,
      ),
    ).toHaveLength(3);
    expect(harnessSource).not.toContain(
      'bun run "$APP_DIR/tests/e2e/setup-localnet.ts"',
    );
    expect(harnessSource).toContain(
      'E2E_PRODUCTION_TRANSACTIONS="${E2E_PRODUCTION_TRANSACTIONS:-false}"',
    );
    expect(harnessSource).toContain(
      "export E2E_APP_RUNTIME E2E_PRODUCTION_TRANSACTIONS",
    );
    expect(harnessSource).toContain(
      'VITE_TRANSACTIONS_ENABLED="$E2E_PRODUCTION_TRANSACTIONS"',
    );
    expect(harnessSource).toContain('"$VITE_BIN" build --mode production');
    expect(harnessSource).toContain('"$VITE_BIN" preview --mode production');
    expect(harnessSource).toContain('"$VITE_BIN" build --mode e2e');
    expect(harnessSource).toContain('"$VITE_BIN" preview --mode e2e');
    expect(harnessSource).not.toContain("PRODUCTION_VITE_MODE");
    expect(harnessSource).not.toContain("VITE_SOLANA_ENABLE_TRANSACTIONS");
    expect(harnessSource).toContain(
      'E2E_BROWSER_AUDIT_HOLD_SECONDS="${E2E_BROWSER_AUDIT_HOLD_SECONDS:-0}"',
    );
    expect(harnessSource).toContain("E2E_BROWSER_AUDIT_HOLD_SECONDS > 900");
    expect(harnessSource).toContain(
      "E2E_BROWSER_AUDIT_HOLD_SECONDS is forbidden in CI",
    );
  });

  test("requires browser acceptance to use normal actionable user clicks", () => {
    const e2eDirectory = fileURLToPath(new URL("../e2e/", import.meta.url));
    const forcedClickLocations = readdirSync(e2eDirectory, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".e2e.ts"))
      .flatMap((entry) => {
        const source = readFileSync(`${e2eDirectory}/${entry.name}`, "utf8");
        return Array.from(source.matchAll(/force\s*:\s*true/g), (match) => ({
          file: entry.name,
          offset: match.index,
        }));
      });

    expect(forcedClickLocations).toEqual([]);
  });

  test("binds the optional full 3D source to real Hyperia truth and decoded HLS", () => {
    expect(harnessSource).toContain(
      'E2E_HYPERIA_RUNTIME="${E2E_HYPERIA_RUNTIME:-compact}"',
    );
    expect(harnessSource).toContain(
      "E2E_HYPERIA_RUNTIME=full_3d requires E2E_DUEL_SOURCE=real_hyperia",
    );
    expect(harnessSource).toContain(
      'E2E_HYPERIA_TERMINAL_EXPECTATION="${E2E_HYPERIA_TERMINAL_EXPECTATION:-natural_kill}"',
    );
    expect(harnessSource).toContain(
      "exact_timeout requires the real_hyperia full_3d runtime",
    );
    expect(harnessSource).toContain(
      "short_kill requires the real_hyperia full_3d runtime with the fixed ranged fixture",
    );
    expect(harnessSource).toContain(
      "E2E_HYPERIA_RUNTIME=full_3d requires E2E_HYPERIA_NATURAL_TERMINAL=true",
    );
    expect(harnessSource).toContain(
      'HYPERIA_ORDINARY_PREPARATION="${E2E_HYPERIA_ORDINARY_PREPARATION:-$HYPERIA_NATURAL_TERMINAL}"',
    );
    expect(harnessSource).toContain(
      "E2E_HYPERIA_RUNTIME=full_3d requires E2E_HYPERIA_ORDINARY_PREPARATION=true",
    );
    expect(harnessSource).toContain(
      'HYPERIA_MULTI_STYLE="${AGENT_DUEL_3D_E2E_MULTI_STYLE:-false}"',
    );
    expect(harnessSource).toContain(
      "AGENT_DUEL_3D_E2E_MULTI_STYLE=true requires full_3d with the ranged fixture",
    );
    expect(harnessSource).toContain(
      "packages/server/scripts/seed-agent-duel-3d-e2e.ts",
    );
    expect(harnessSource).toContain(
      "packages/server/scripts/test-agent-preparation-to-duel-combined.ts",
    );
    expect(harnessSource).toContain(
      "packages/server/scripts/configure-agent-duel-3d-timeout-e2e.ts",
    );
    expect(harnessSource).toContain(
      "packages/server/scripts/configure-agent-duel-3d-short-kill-e2e.ts",
    );
    expect(harnessSource).toContain("--prepare-existing-database");
    expect(harnessSource).toContain(
      'AGENT_DUEL_3D_E2E_ORDINARY_PREPARATION "$HYPERIA_ORDINARY_PREPARATION"',
    );
    expect(harnessSource).toContain(
      'AGENT_DUEL_3D_E2E_MULTI_STYLE "$HYPERIA_MULTI_STYLE"',
    );
    expect(harnessSource).toContain('POSTGRES_POOL_MAX "12"');
    expect(harnessSource).toContain('POSTGRES_POOL_MIN "0"');
    expect(harnessSource).toContain(
      "running ordinary physical gather/cook/bank preparation against the launch database",
    );
    expect(harnessSource).not.toContain(".totals.ordinaryBankOperations == 2");
    expect(
      harnessSource.match(
        /\.totals\.ordinaryBankOperations ==\n\s+\(\[\.agents\[\]\.ordinaryBankOperations\] \| add\)/g,
      ),
    ).toHaveLength(2);
    expect(
      harnessSource.match(
        /\$agent\.ordinaryBankOperations == \(1 \+ \$setupDeposits\)/g,
      ),
    ).toHaveLength(2);
    expect(harnessSource).toContain(
      ".ordinaryAutonomySelectionCovered == true",
    );
    expect(harnessSource).toContain(".scriptedCustodyBridgeCovered == false");
    expect(harnessSource).toContain(".workerDatabaseSessionsDrained == true");
    expect(
      harnessSource.match(
        /\.schemaVersion == 3 and\n\s+\.status == "passed" and\n\s+\.multiStyle == \$expectedMultiStyle/g,
      ),
    ).toHaveLength(2);
    expect(
      harnessSource.match(
        /\.ownedMultiStylePreparationCovered == \$expectedMultiStyle/g,
      ),
    ).toHaveLength(2);
    expect(
      harnessSource.match(
        /\.ordinaryForgingQuestCovered == \$expectedMultiStyle/g,
      ),
    ).toHaveLength(2);
    expect(harnessSource).toContain(".externalModelProviderCovered == false");
    expect(harnessSource).toContain(
      "(.remainingWorkerDatabaseSessionPids | length) == 0",
    );
    expect(harnessSource).toContain("scripts/duel-stack.mjs");
    expect(harnessSource).toContain("--skip-bots");
    expect(harnessSource.match(/--local-smoke/g)).toHaveLength(2);
    expect(harnessSource).toContain('"$HYPERIA_URL/api/streaming/betting"');
    expect(harnessSource).toContain(
      'tolower($1) == "access-control-allow-origin"',
    );
    expect(harnessSource).toContain(
      '"$hyperia_betting_cors_origin" != "$hyperia_browser_origin"',
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.expectedAgentCount == 2",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 2",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.visibleAgentFramingCount == 1",
    );
    expect(harnessSource).toContain(
      '.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent1"',
    );
    expect(harnessSource).toContain(
      '.rendererHealth.diagnostics.sceneReadiness.cameraTargetSlot == "agent2"',
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.fullyFramedAgentSlots",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.unobstructedVisibleAgentSlots",
    );
    expect(harnessSource).toContain("local preparation_pair_shot_active");
    expect(harnessSource).toContain(
      '"$preparation_pair_shot_active" == "true"',
    );
    expect(harnessSource).toContain(
      "capture_qualified_full_3d_preparation_frame",
    );
    expect(harnessSource).toContain(
      'STREAM_CAPTURE_BROWSER_FRAME_REQUEST_FILE "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE"',
    );
    expect(harnessSource).toContain(
      'STREAM_CAPTURE_BROWSER_FRAME_STATUS_FILE "$HYPERIA_CAPTURE_FRAME_STATUS_FILE"',
    );
    expect(harnessSource).toContain(
      'STREAM_CAPTURE_BROWSER_FRAME_OUTPUT_DIRECTORY "$APP_DIR"',
    );
    expect(harnessSource).toContain(
      'mv -- "$request_temporary" "$HYPERIA_CAPTURE_FRAME_REQUEST_FILE"',
    );
    expect(harnessSource).toContain('.source == "capture-browser-host" and');
    expect(harnessSource).toContain("schemaVersion: 2");
    expect(harnessSource).toContain(
      "expectedCameraTargetSlot: $expectedCameraTargetSlot",
    );
    expect(harnessSource).toContain("expectedPairShot: $expectedPairShot");
    expect(harnessSource).toContain(".cameraTargetSlot == $expectedSlot");
    expect(harnessSource).toContain(
      ".preparationPairShotActive == $expectedPairShot",
    );
    expect(harnessSource).toContain(
      'output_sha256="$(shasum -a 256 "$output_path"',
    );
    expect(harnessSource).not.toContain(
      "packages/server/scripts/capture-browser-frame.ts",
    );
    expect(harnessSource).toContain(
      'captured_frame_renderer_status="$post_capture_renderer_status"',
    );
    expect(harnessSource).toContain(
      'captured_frame_public_state="$post_capture_public_state"',
    );
    const retainedPreparationGateStart = harnessSource.indexOf(
      'renderer_status="$retained_preparation_renderer_status"',
    );
    const retainedPreparationGateEnd = harnessSource.indexOf(
      'echo "[e2e] renderer was not healthy in the exact public preparation frame"',
      retainedPreparationGateStart,
    );
    expect(retainedPreparationGateStart).toBeGreaterThanOrEqual(0);
    expect(retainedPreparationGateEnd).toBeGreaterThan(
      retainedPreparationGateStart,
    );
    const retainedPreparationGate = harnessSource.slice(
      retainedPreparationGateStart,
      retainedPreparationGateEnd,
    );
    expect(retainedPreparationGate).toContain(
      "(if .rendererHealth.diagnostics.sceneReadiness.preparationPairShotActive == true then",
    );
    expect(retainedPreparationGate).not.toMatch(
      /preparationShotActive == true and\s+\.rendererHealth\.diagnostics\.sceneReadiness\.cameraTargetMatchesExpected == true and/,
    );
    expect(retainedPreparationGate).toContain(
      '.fullyFramedAgentSlots | index("agent1") != null',
    );
    expect(retainedPreparationGate).toContain(
      '.fullyFramedAgentSlots | index("agent2") != null',
    );
    expect(harnessSource).toContain(
      '"$post_capture_preparation_identity" != "$expected_preparation_identity"',
    );
    expect(harnessSource).toContain(
      'HYPERIA_PREPARATION_AGENT1_FRAME_FILE="$APP_DIR/.e2e-hyperia-preparation-agent1-frame.png"',
    );
    expect(harnessSource).toContain(
      'HYPERIA_PREPARATION_AGENT2_FRAME_FILE="$APP_DIR/.e2e-hyperia-preparation-agent2-frame.png"',
    );
    expect(harnessSource).toContain('source: "capture_browser"');
    expect(harnessSource).toContain("agent1-shot-renderer-status.json");
    expect(harnessSource).toContain("agent2-shot-renderer-status.json");
    expect(harnessSource).toContain('then "pair" else "directed_cuts" end');
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.croppedVisibleAgentBodyCount == 0",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentHorizontalNdcSeparation >= 0.24",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.minimumVisibleAgentBodyNdcSpan >= 0.55",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.maximumVisibleAgentBodyNdcSpan <= 0.75",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.equipmentReadyCount ==",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.equipmentRequiredCount",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.equipmentUnresolvedCount == 0",
    );
    expect(harnessSource).toContain(
      ".rendererHealth.diagnostics.sceneReadiness.equipmentAttachmentMismatchCount == 0",
    );
    expect(harnessSource).toContain(
      "full_3d source missed the open betting window before downstream startup",
    );
    expect(harnessSource).not.toContain(
      ".rendererHealth.diagnostics.sceneReadiness.equipmentActiveVisiblePlayerCount == 2",
    );
    expect(harnessSource).toContain('.stats.audioSource == "browser"');
    expect(harnessSource).toContain(".stats.audioDroppedChunks == 0");
    expect(harnessSource).toContain(".stats.audioTrimmedChunks == 0");
    expect(harnessSource).toContain(
      '.browserAudioCaptureHealth.contextState == "running"',
    );
    expect(harnessSource).toContain(
      '.browserAudioCaptureHealth.sourceContextState == "running"',
    );
    expect(harnessSource).toContain(
      '.browserAudioCaptureHealth.trackState == "live"',
    );
    expect(harnessSource).toContain(
      ".browserAudioCaptureHealth.droppedChunks == 0",
    );
    expect(harnessSource).toContain(
      ".browserAudioCaptureHealth.pendingWrites == 0",
    );
    expect(harnessSource).toContain(
      'retained_preparation_identity" == "$preparation_identity',
    );
    expect(harnessSource).toContain(
      'if [[ "${E2E_SKIP_PREBUILD:-false}" == "true" ]]',
    );
    expect(harnessSource).toContain("local hyperia_build_args=(--isolated)");
    expect(harnessSource).toContain(
      ".rendererHealth.updatedAt >= $capturedAtMs",
    );
    expect(harnessSource).toContain(
      "retained preparation renderer authority never reached an audio-drained snapshot",
    );
    expect(harnessSource).toContain('DEFAULT_HYPERIA_PREPARATION_MS="600000"');
    expect(harnessSource).toContain(
      'HYPERIA_PREPARATION_MS="${E2E_HYPERIA_PREPARATION_MS:-$DEFAULT_HYPERIA_PREPARATION_MS}"',
    );
    expect(harnessSource).toContain(
      "full_3d preparation authority must cover the complete bounded startup readiness envelope",
    );
    expect(harnessSource).toContain(
      'STREAMING_DUEL_PREPARATION_MS "$HYPERIA_PREPARATION_MS"',
    );
    expect(harnessSource).toContain(
      'STREAMING_DUEL_PUBLIC_PREPARATION_MIN_MS "$HYPERIA_PUBLIC_PREPARATION_MIN_MS"',
    );
    expect(harnessSource).toContain('STREAMING_FIGHTING_MS "150000"');
    expect(harnessSource).toContain('STREAMING_END_WARNING_MS "10000"');
    expect(harnessSource).toContain("capture_full_3d_public_preparation");
    expect(harnessSource).toContain("frozenBettingSource");
    expect(harnessSource).toContain(
      "captured authoritative public 3D preparation before market publication",
    );
    expect(harnessSource).toContain(
      "test-results/hyperia-preparation-gate-failure-$captured_at_ms",
    );
    expect(harnessSource).toContain(
      "local preparation_observation_attempts=1200",
    );
    expect(harnessSource).toContain("sleep 0.25");
    expect(harnessSource).not.toContain(
      'pkill -f "packages/hyperbet-solana/app/scripts/solana-rpc-proxy.mjs"',
    );
    expect(harnessSource).toContain(
      "using the owned Hyperia 3D renderer HLS source",
    );
    expect(harnessSource).toContain(
      'HYPERIA_AUTHORITY_HEALTH_URL="$HYPERIA_URL/api/internal/bet-sync/authority-health"',
    );
    expect(harnessSource).toContain(
      "authorityHealthUrl: $hyperiaAuthorityHealthUrl",
    );
    expect(harnessSource).toContain(
      'STREAMING_DUEL_SHUTDOWN_ACK_URL "$GAME_API_URL/api/keeper/bot-health"',
    );
    expect(harnessSource).toContain(
      'E2E_HYPERIA_BET_SYNC_BEARER_TOKEN="$HYPERIA_BET_SYNC_TOKEN"',
    );
    expect(harnessSource).toContain(
      'E2E_HYPERIA_ADMIN_CODE="$HYPERIA_ADMIN_CODE"',
    );

    expect(marketFlowsSource).toContain(
      'control.services.hyperia?.runtime).toBe("full_3d")',
    );
    expect(marketFlowsSource).toContain(
      "control.services.hyperia?.authorityHealthUrl",
    );
    expect(marketFlowsSource).toContain(
      "readFull3DPreparationEvidence(control)",
    );
    expect(marketFlowsSource).toContain("ordinaryPreparation: {");
    expect(marketFlowsSource).toContain("schemaVersion: 3;");
    expect(marketFlowsSource).toContain(
      "ownedMultiStylePreparationCovered: boolean;",
    );
    expect(marketFlowsSource).toContain(
      "ordinaryForgingQuestCovered: HYPERIA_MULTI_STYLE",
    );
    expect(marketFlowsSource).toContain(
      "natural-hyperia-3d-public-preparation-hls-decoded-frame",
    );
    expect(marketFlowsSource).toContain(
      "natural-hyperia-3d-public-preparation-${shot.slot}",
    );
    expect(marketFlowsSource).toContain('frameSource: "capture_browser"');
    expect(marketFlowsSource).toContain("targetUnobstructed: true");
    expect(marketFlowsSource).toContain(
      '[data-testid="e2e-debug-panel"] { display: none !important; }',
    );
    expect(marketFlowsSource).toContain(
      "frozenBettingSource.competitiveSnapshot.preparationId",
    );
    expect(marketFlowsSource).toContain("ordinaryPreparation.liveWorldReports");
    expect(marketFlowsSource).toContain(
      "item.itemId === HYPERIA_PREPARATION_FOOD.itemId",
    );
    expect(marketFlowsSource).toContain(
      "frozenFood + bankedFood).toBe(agent.cookedFood)",
    );
    expect(marketFlowsSource).toContain("planOperations: Array<{");
    expect(marketFlowsSource).toMatch(
      /const finalCombatAIs = await fetchHyperiaCombatAIDiagnostics\(\s*request,\s*control,\s*\);/u,
    );
    expect(marketFlowsSource).toContain(
      '"natural-hyperia-combat-ai-prayer-failure.json"',
    );
    expect(marketFlowsSource).toContain('diagnosticScope: "operator_private"');
    expect(marketFlowsSource).toContain('trigger: "terminal_snapshot"');
    expect(marketFlowsSource).toContain("operatorPrivateCombatAIDiagnostics");
    expect(marketFlowsSource).not.toContain("nextCombatAIDiagnosticsPollAtMs");
    expect(marketFlowsSource).toContain("rejectedOrErroredPrayerActions: 0");
    expect(marketFlowsSource).toContain("unplannedOpeningPrayerActions: 0");
    const combatActionEvidenceWrite = marketFlowsSource.indexOf(
      "fs.writeFileSync(combatActionEvidencePath",
    );
    const zeroPrayerRejectionAssertion = marketFlowsSource.indexOf(
      "rejectedOrErroredPrayerActions: 0",
    );
    expect(combatActionEvidenceWrite).toBeGreaterThan(-1);
    expect(zeroPrayerRejectionAssertion).toBeGreaterThan(-1);
    expect(combatActionEvidenceWrite).toBeLessThan(
      zeroPrayerRejectionAssertion,
    );
    expect(harnessSource).toContain("'planOperations'\\'', COALESCE((");
    expect(marketFlowsSource).toContain(
      'contestant!.preparation.planningSource).toBe("deterministic")',
    );
    expect(marketFlowsSource).toContain(
      'page.locator("video[data-stream-source]")',
    );
    expect(marketFlowsSource).toContain("secondPlayback.totalVideoFrames");
    expect(marketFlowsSource).toContain("sceneCycleId: terminalCycle.cycleId");
    expect(marketFlowsSource).toContain('rendererPhase: "RESOLUTION"');
    expect(marketFlowsSource).toContain("damagePresentationAvailable: true");
    expect(marketFlowsSource).toContain("activeDamageSplatCount: 0");
    expect(marketFlowsSource).toContain('browserAudioContextState: "running"');
    expect(marketFlowsSource).toContain(
      'browserAudioSourceContextState: "running"',
    );
    expect(marketFlowsSource).toContain('browserAudioTrackState: "live"');
    expect(marketFlowsSource).toContain("browserAudioSampleRate: 48_000");
    expect(marketFlowsSource).toContain("browserAudioChannels: 2");
    expect(marketFlowsSource).toContain("browserAudioDroppedChunks: 0");
    expect(marketFlowsSource).toContain("browserAudioPendingWrites: 0");
    expect(marketFlowsSource).toContain("bridgeAudioTrimmedChunks: 0");
    expect(marketFlowsSource).toContain("captureFrameCadenceHealthy");
    expect(marketFlowsSource).toContain(
      "repeatedFrames / emittedFrames <= 0.05",
    );
    expect(marketFlowsSource).toContain(
      'rendererHealth && "degradedReason" in rendererHealth',
    );
    expect(marketFlowsSource).not.toContain(
      'rendererHealth?.degradedReason ?? "missing"',
    );
    expect(marketFlowsSource).toContain(
      'mode: "advanced_cycle_with_historical_claim"',
    );
    expect(marketFlowsSource).toContain(
      "function settlementEntriesForDuel(page: Page, duelId: string): Locator",
    );
    expect(marketFlowsSource).toContain(
      "has: page.getByTitle(duelId, { exact: true })",
    );
    expect(marketFlowsSource).not.toContain(".filter({ hasText: duelId })");
    expect(marketFlowsSource).not.toContain(
      ".filter({ hasText: activeFixture.duelId })",
    );
    expect(marketFlowsSource).toContain(
      'exactDuelActivity.filter({ hasText: "Winnings ready to claim" })',
    );
    expect(marketFlowsSource).toContain(
      'exactDuelActivity.filter({ hasText: "Resolved · no payout" })',
    );
    expect(marketFlowsSource).toContain(
      "expect(playbackAdvanceSeconds).toBeGreaterThan(1)",
    );
    expect(marketFlowsSource).toContain(
      'timeoutPolicy: "hp_percentage_then_damage_then_draw_v1"',
    );
    expect(marketFlowsSource).toContain("contractVersion: 2");
    expect(marketFlowsSource).toContain("endWarningDurationMs: 10_000");
    expect(marketFlowsSource).toContain("maxFightDurationMs: 160_000");
    expect(marketFlowsSource).toContain(
      "duelEndTime: EXPECT_EXACT_HYPERIA_TIMEOUT",
    );
    expect(marketFlowsSource).toContain('"natural-hyperia-sol-terminal.json"');
    expect(marketFlowsSource).toContain(
      "fs.writeFileSync(\n      terminalEvidencePath,",
    );
    const terminalAttachmentStart = marketFlowsSource.indexOf(
      'await testInfo.attach("natural-hyperia-sol-terminal",',
    );
    const terminalAttachmentEnd = marketFlowsSource.indexOf(
      'await testInfo.attach("natural-hyperia-sol-terminal-ui",',
      terminalAttachmentStart,
    );
    expect(terminalAttachmentStart).toBeGreaterThan(-1);
    expect(terminalAttachmentEnd).toBeGreaterThan(terminalAttachmentStart);
    const terminalAttachmentSource = marketFlowsSource.slice(
      terminalAttachmentStart,
      terminalAttachmentEnd,
    );
    expect(terminalAttachmentSource).toContain("path: terminalEvidencePath");
    expect(terminalAttachmentSource).not.toContain("body:");
  });
});
