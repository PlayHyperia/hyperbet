import { Buffer } from "node:buffer";
import { assertCaptureFaultEvidence } from "./wagerAuthorityCapture";

export const WAGER_AUTHORITY_BOUNDARIES = [
  "review",
  "before-wallet",
  "wallet",
  "broadcast",
] as const;
export const CAPTURE_WAGER_AUTHORITY_BOUNDARIES = [
  "wallet",
  "broadcast",
] as const;

export function wagerAuthorityTestTitle(boundary: string): string {
  return `wager authority outage at ${boundary} preserves the exact signing boundary`;
}

export function captureWagerAuthorityTestTitle(boundary: string): string {
  return `real capture outage at ${boundary} preserves the exact signing boundary`;
}

/** Presentation may retain the exact delayed duel; wagering must be revoked. */
export function isCaptureViewerAuthorityRevoked(
  value: unknown,
  authority: { duelId: string; duelKey: string },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const viewer = value as Record<string, unknown>;
  const presentationMatches =
    (viewer.streamDuelId === null && viewer.streamDuelKey === null) ||
    (viewer.streamDuelId === authority.duelId &&
      viewer.streamDuelKey === authority.duelKey);
  // Counts cover every matching element, including hidden/duplicate controls.
  // Read-only mode removes order entry but retains transaction receipts.
  return (
    viewer.marketDuelId === authority.duelId &&
    viewer.marketDuelKey === authority.duelKey &&
    presentationMatches &&
    viewer.canPlaceBet === "false" &&
    viewer.dialogCount === 0 &&
    typeof viewer.submitPresent === "number" &&
    Number.isSafeInteger(viewer.submitPresent) &&
    viewer.submitPresent >= 0 &&
    viewer.submitPresent <= 128 &&
    viewer.submitDisabled === viewer.submitPresent
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wager authority report contains an invalid object");
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Wager authority evidence ${field} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Wager authority evidence ${field} is invalid`);
  }
  return value;
}

export function assertWagerAuthorityTrackingEvidence(value: unknown): void {
  const evidence = record(value);
  const attempts = evidence.trackingAttempts;
  if (
    !Array.isArray(attempts) ||
    attempts.length < 1 ||
    attempts.length > 128 ||
    evidence.records !== attempts.length ||
    evidence.successfulRecords !== 1
  ) {
    throw new Error("Wager tracking attempts are missing or unbounded");
  }
  let initialPayload: string | undefined;
  for (const [index, entry] of attempts.entries()) {
    const attempt = record(entry);
    const payload = record(attempt.payload);
    const serialized = JSON.stringify(payload);
    initialPayload ??= serialized;
    if (
      serialized !== initialPayload ||
      payload.chainKey !== "solana" ||
      payload.chain !== "SOLANA" ||
      payload.sourceAsset !== "SOL" ||
      payload.sourceAmountLamports !== "50000000" ||
      payload.bettorWallet !== evidence.wallet ||
      payload.txSignature !== evidence.signature ||
      payload.externalBetRef !== `solana:${evidence.signature}` ||
      payload.marketRef !== evidence.market ||
      payload.marketPda !== evidence.market ||
      payload.duelId !== evidence.duelId ||
      payload.duelKey !== evidence.duelKey ||
      (index === attempts.length - 1
        ? attempt.status !== 200
        : attempt.status !== 425 && attempt.status !== 503)
    ) {
      throw new Error(
        "Wager tracking must retry one identical order until one acceptance",
      );
    }
  }
}

function assertEvidence(
  result: Record<string, unknown>,
  boundary: (typeof WAGER_AUTHORITY_BOUNDARIES)[number],
  realCapture: boolean,
): void {
  if (!Array.isArray(result.attachments)) {
    throw new Error("Wager authority evidence attachment is missing");
  }
  const matches = result.attachments
    .map(record)
    .filter((attachment) => attachment.name === "wager-authority-evidence");
  if (matches.length !== 1 || matches[0].contentType !== "application/json") {
    throw new Error("Wager authority evidence attachment is not unique JSON");
  }
  const body = matches[0].body;
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("Wager authority evidence attachment body is missing");
  }
  let evidence: Record<string, unknown>;
  try {
    evidence = record(JSON.parse(Buffer.from(body, "base64").toString("utf8")));
  } catch {
    throw new Error("Wager authority evidence attachment body is invalid");
  }

  if (
    evidence.schemaVersion !== 2 ||
    evidence.boundary !== boundary ||
    evidence.source !== (realCapture ? "real_hyperia" : "synthetic_publish") ||
    evidence.externalValue !== false ||
    evidence.runtime !== "production_preview_e2e_mode" ||
    evidence.realRendererFault !== false ||
    evidence.realWalletSigning !== true ||
    evidence.sends !== 1 ||
    evidence.successfulRecords !== 1 ||
    evidence.walletRequests !== (boundary === "wallet" ? 2 : 1) ||
    evidence.finalizedAccountConservation !== true
  ) {
    throw new Error("Wager authority evidence claims are invalid");
  }
  if (realCapture) {
    if (evidence.realCaptureFault !== true)
      throw new Error("Actual capture fault evidence is required");
    assertCaptureFaultEvidence(evidence.captureFault);
    const fault = record(evidence.captureFault);
    const authority = record(evidence.authorityAtLoss);
    const viewer = record(authority.viewer);
    if (
      !Array.isArray(authority.apis) ||
      authority.apis.length !== 2 ||
      !isCaptureViewerAuthorityRevoked(viewer, {
        duelId: String(evidence.duelId),
        duelKey: String(evidence.duelKey),
      })
    )
      throw new Error(
        "Capture outage did not retain fail-closed viewer authority",
      );
    for (const entry of authority.apis) {
      const api = record(entry);
      const health = record(api.rendererHealth);
      if (
        api.duelId !== evidence.duelId ||
        api.duelKeyHex !== evidence.duelKey ||
        api.competitiveSnapshotDigest !== evidence.competitiveSnapshotDigest ||
        health.ready !== false ||
        typeof health.degradedReason !== "string" ||
        !health.degradedReason.startsWith("capture_") ||
        nonNegativeInteger(health.updatedAt, "capture fault timestamp") <
          Number(fault.killedAt) ||
        Number(health.updatedAt) > Number(fault.apiFailClosedAt)
      )
        throw new Error(
          "Capture outage did not retain fail-closed API authority",
        );
    }
    if (
      typeof evidence.initialAShares !== "string" ||
      typeof evidence.finalAShares !== "string" ||
      !/^[0-9]+$/.test(evidence.initialAShares) ||
      !/^[0-9]+$/.test(evidence.finalAShares) ||
      BigInt(evidence.finalAShares) - BigInt(evidence.initialAShares) !==
        50_000_000n
    )
      throw new Error("Actual capture wager share delta is invalid");
  } else if (
    evidence.realCaptureFault === true ||
    evidence.captureFault != null
  ) {
    throw new Error("Synthetic evidence cannot claim an actual capture fault");
  }

  const base58Address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const base58Signature = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
  if (
    typeof evidence.genesis !== "string" ||
    !base58Address.test(evidence.genesis) ||
    typeof evidence.wallet !== "string" ||
    !base58Address.test(evidence.wallet) ||
    typeof evidence.market !== "string" ||
    !base58Address.test(evidence.market) ||
    typeof evidence.duelId !== "string" ||
    !(
      realCapture
        ? /^streaming-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
        : /^[1-9][0-9]*$/
    ).test(evidence.duelId) ||
    typeof evidence.duelKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.duelKey) ||
    typeof evidence.competitiveSnapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.competitiveSnapshotDigest) ||
    typeof evidence.signature !== "string" ||
    !base58Signature.test(evidence.signature)
  ) {
    throw new Error("Wager authority evidence identity is invalid");
  }
  assertWagerAuthorityTrackingEvidence(evidence);

  const before = record(evidence.beforeChain);
  const after = record(evidence.afterChain);
  const beforeLamports = nonNegativeInteger(before.lamports, "before lamports");
  const afterLamports = nonNegativeInteger(after.lamports, "after lamports");
  const beforeSignatures = stringArray(before.signatures, "before signatures");
  const afterSignatures = stringArray(after.signatures, "after signatures");
  if (
    !beforeSignatures.every((signature) => base58Signature.test(signature)) ||
    !afterSignatures.every((signature) => base58Signature.test(signature)) ||
    JSON.stringify(
      afterSignatures.filter(
        (signature) => !beforeSignatures.includes(signature),
      ),
    ) !== JSON.stringify([evidence.signature]) ||
    afterLamports >= beforeLamports ||
    nonNegativeInteger(evidence.feeLamports, "fee lamports") <= 0 ||
    nonNegativeInteger(evidence.walletDebitLamports, "wallet debit") !==
      beforeLamports - afterLamports
  ) {
    throw new Error("Wager authority evidence chain delta is invalid");
  }
}

/** A selected matrix cannot pass through skips, retries, or omitted stages. */
export function assertWagerAuthorityBrowserReport(value: unknown): void {
  assertAuthorityBrowserReport(value, false);
}

export function assertCaptureWagerAuthorityBrowserReport(value: unknown): void {
  assertAuthorityBrowserReport(value, true);
}

function assertAuthorityBrowserReport(
  value: unknown,
  realCapture: boolean,
): void {
  const boundaries = realCapture
    ? CAPTURE_WAGER_AUTHORITY_BOUNDARIES
    : WAGER_AUTHORITY_BOUNDARIES;
  const title = realCapture
    ? captureWagerAuthorityTestTitle
    : wagerAuthorityTestTitle;
  const report = record(value);
  const config = record(report.config);
  if (!Array.isArray(config.projects) || config.projects.length !== 1) {
    throw new Error("Wager authority report must use one Chromium project");
  }
  const project = record(config.projects[0]);
  if (
    project.name !== "chromium" ||
    project.retries !== 0 ||
    project.repeatEach !== 1
  ) {
    throw new Error(
      "Wager authority report must use Chromium without retries or repeats",
    );
  }
  const stats = record(report.stats);
  if (
    stats.expected !== boundaries.length ||
    stats.skipped !== 0 ||
    stats.unexpected !== 0 ||
    stats.flaky !== 0 ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  ) {
    throw new Error(
      `Wager authority matrix requires ${boundaries.length} passes and zero skips or failures`,
    );
  }
  const specs: Record<string, unknown>[] = [];
  const visit = (suites: unknown): void => {
    if (!Array.isArray(suites))
      throw new Error("Wager authority suites are missing");
    for (const entry of suites) {
      const suite = record(entry);
      if (Array.isArray(suite.specs)) specs.push(...suite.specs.map(record));
      if (suite.suites !== undefined) visit(suite.suites);
    }
  };
  visit(report.suites);
  const expectedTitles = boundaries.map(title).sort();
  if (
    JSON.stringify(specs.map((spec) => spec.title).sort()) !==
    JSON.stringify(expectedTitles)
  ) {
    throw new Error(
      "Wager authority matrix must execute each exact stage once",
    );
  }
  const specIds = new Set<string>();
  for (const spec of specs) {
    const boundary = boundaries.find(
      (candidate) => title(candidate) === spec.title,
    );
    if (
      boundary === undefined ||
      spec.file !== "solana-clob-ui.e2e.ts" ||
      typeof spec.id !== "string" ||
      spec.id.length === 0 ||
      specIds.has(spec.id) ||
      spec.ok !== true ||
      !Array.isArray(spec.tests) ||
      spec.tests.length !== 1
    ) {
      throw new Error("Wager authority stage did not pass exactly once");
    }
    specIds.add(spec.id);
    const test = record(spec.tests[0]);
    if (
      test.status !== "expected" ||
      test.expectedStatus !== "passed" ||
      test.projectName !== "chromium" ||
      !Array.isArray(test.results) ||
      test.results.length !== 1
    ) {
      throw new Error("Wager authority stage was skipped, retried, or failed");
    }
    const result = record(test.results[0]);
    if (
      result.status !== "passed" ||
      result.retry !== 0 ||
      !Array.isArray(result.errors) ||
      result.errors.length !== 0
    ) {
      throw new Error("Wager authority stage was skipped, retried, or failed");
    }
    assertEvidence(result, boundary, realCapture);
  }
}
