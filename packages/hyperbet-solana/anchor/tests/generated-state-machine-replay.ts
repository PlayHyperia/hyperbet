export const GENERATED_CORPUS_SCHEMA_VERSION = 1;
export const GENERATED_FAILURE_SCHEMA_VERSION = 1;
export const GENERATED_REPLAY_TERMINAL_PADDING_WORDS = 64;

export type GeneratedSeedCase = {
  id: string;
  kind: "seed";
  seed: string;
  openActionCount: number;
  enforceCoverage: true;
};

export type GeneratedReplayCase = {
  id: string;
  kind: "replay";
  sourceSeed: string;
  randomWords: number[];
  openActionCount: number;
  enforceCoverage: false;
  historicalFailureFingerprint: string;
};

export type GeneratedCorpusCase = GeneratedSeedCase | GeneratedReplayCase;

export type GeneratedStateMachineCorpus = {
  schemaVersion: 1;
  randomWordCount: number;
  cases: GeneratedCorpusCase[];
};

export type GeneratedFailureArtifact = {
  schemaVersion: 1;
  caseId: string;
  sourceSeed: string;
  failureFingerprint: string;
  originalRandomWordCount: number;
  reducedRandomWords: number[];
  openActionCount: number;
  actionTrace: string[];
};

export type ShrinkResult<T> = {
  items: T[];
  attempts: number;
  budgetExhausted: boolean;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function requireUint32(value: unknown, label: string): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < 0 ||
    Number(value) > 0xffffffff
  ) {
    throw new Error(`${label} must be a uint32`);
  }
  return Number(value) >>> 0;
}

export function parseUint32Seed(seed: string): number {
  if (!/^0x[0-9a-fA-F]{1,8}$/.test(seed)) {
    throw new Error(`seed must be a 1-8 digit hexadecimal uint32: ${seed}`);
  }
  return Number.parseInt(seed.slice(2), 16) >>> 0;
}

export function formatUint32Seed(seed: number): string {
  return `0x${requireUint32(seed, "seed").toString(16).padStart(8, "0")}`;
}

export function generateRandomWords(seed: number, count: number): number[] {
  let state = requireUint32(seed, "seed");
  const wordCount = requirePositiveInteger(count, "random word count");
  const words: number[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    words.push(state);
  }
  return words;
}

export class GeneratedRandomTape {
  readonly words: readonly number[];
  #cursor = 0;

  constructor(words: readonly number[]) {
    this.words = words.map((word, index) =>
      requireUint32(word, `randomWords[${index}]`),
    );
  }

  get consumed(): number {
    return this.#cursor;
  }

  take(limit: number): number {
    const safeLimit = requirePositiveInteger(limit, "random limit");
    const word = this.words[this.#cursor];
    if (word === undefined) {
      throw new Error(
        `generated random tape exhausted at word ${this.#cursor} for limit ${safeLimit}`,
      );
    }
    this.#cursor += 1;
    return word % safeLimit;
  }
}

export function parseGeneratedCorpus(
  value: unknown,
): GeneratedStateMachineCorpus {
  const root = requireRecord(value, "generated corpus");
  if (root.schemaVersion !== GENERATED_CORPUS_SCHEMA_VERSION) {
    throw new Error(
      `generated corpus schemaVersion must be ${GENERATED_CORPUS_SCHEMA_VERSION}`,
    );
  }
  const randomWordCount = requirePositiveInteger(
    root.randomWordCount,
    "generated corpus randomWordCount",
  );
  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    throw new Error("generated corpus cases must be a non-empty array");
  }

  const ids = new Set<string>();
  const cases = root.cases.map((rawCase, caseIndex): GeneratedCorpusCase => {
    const entry = requireRecord(rawCase, `generated corpus case ${caseIndex}`);
    const id = requireNonEmptyString(
      entry.id,
      `generated corpus case ${caseIndex}.id`,
    );
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`generated corpus case id is not canonical: ${id}`);
    }
    if (ids.has(id)) {
      throw new Error(`duplicate generated corpus case id: ${id}`);
    }
    ids.add(id);
    const openActionCount = requirePositiveInteger(
      entry.openActionCount,
      `generated corpus case ${id}.openActionCount`,
    );

    if (entry.kind === "seed") {
      if (entry.enforceCoverage !== true) {
        throw new Error(`seed case ${id} must enforce coverage`);
      }
      const seed = requireNonEmptyString(entry.seed, `seed case ${id}.seed`);
      parseUint32Seed(seed);
      return {
        id,
        kind: "seed",
        seed: formatUint32Seed(parseUint32Seed(seed)),
        openActionCount,
        enforceCoverage: true,
      };
    }

    if (entry.kind === "replay") {
      if (entry.enforceCoverage !== false) {
        throw new Error(
          `replay case ${id} must not enforce aggregate coverage`,
        );
      }
      const sourceSeed = formatUint32Seed(
        parseUint32Seed(
          requireNonEmptyString(
            entry.sourceSeed,
            `replay case ${id}.sourceSeed`,
          ),
        ),
      );
      if (!Array.isArray(entry.randomWords) || entry.randomWords.length === 0) {
        throw new Error(`replay case ${id}.randomWords must be non-empty`);
      }
      const randomWords = entry.randomWords.map((word, wordIndex) =>
        requireUint32(word, `replay case ${id}.randomWords[${wordIndex}]`),
      );
      return {
        id,
        kind: "replay",
        sourceSeed,
        randomWords,
        openActionCount,
        enforceCoverage: false,
        historicalFailureFingerprint: requireNonEmptyString(
          entry.historicalFailureFingerprint,
          `replay case ${id}.historicalFailureFingerprint`,
        ),
      };
    }

    throw new Error(`generated corpus case ${id} has unsupported kind`);
  });

  return {
    schemaVersion: GENERATED_CORPUS_SCHEMA_VERSION,
    randomWordCount,
    cases,
  };
}

export function randomWordsForCase(
  testCase: GeneratedCorpusCase,
  randomWordCount: number,
): number[] {
  if (testCase.kind === "replay") {
    return [
      ...testCase.randomWords,
      ...generateRandomWords(
        (parseUint32Seed(testCase.sourceSeed) ^ 0xa5a5a5a5) >>> 0,
        GENERATED_REPLAY_TERMINAL_PADDING_WORDS,
      ),
    ];
  }
  return generateRandomWords(parseUint32Seed(testCase.seed), randomWordCount);
}

export function stableFailureFingerprint(error: unknown): string {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    failureFingerprint?: unknown;
    errorCode?: { code?: unknown };
    error?: { errorCode?: { code?: unknown } };
  };
  if (
    typeof candidate?.failureFingerprint === "string" &&
    candidate.failureFingerprint !== ""
  ) {
    return candidate.failureFingerprint;
  }
  const name =
    typeof candidate?.name === "string" && candidate.name !== ""
      ? candidate.name
      : "Error";
  const codeCandidate =
    candidate?.error?.errorCode?.code ??
    candidate?.errorCode?.code ??
    candidate?.code;
  const code =
    typeof codeCandidate === "string" || typeof codeCandidate === "number"
      ? String(codeCandidate)
      : "none";
  const rawMessage =
    typeof candidate?.message === "string" ? candidate.message : String(error);
  const firstLine = rawMessage.split("\n", 1)[0] ?? "unknown failure";
  const stableMessage = firstLine
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, "<signature>")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<pubkey>")
    .replace(/0x[0-9a-fA-F]{16,}/g, "<hex>")
    .slice(0, 512);
  return `${name}|${code}|${stableMessage}`;
}

export async function shrinkFailingSequence<T>(
  originalItems: readonly T[],
  reproduces: (candidate: readonly T[]) => Promise<boolean>,
  options: {
    maxAttempts?: number;
    deadlineMs?: number;
    minimumItems?: number;
    assumeOriginalReproduces?: boolean;
  } = {},
): Promise<ShrinkResult<T>> {
  const maxAttempts = options.maxAttempts ?? 32;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("shrink maxAttempts must be a positive safe integer");
  }
  let attempts = 0;
  const minimumItems = options.minimumItems ?? 0;
  if (
    !Number.isSafeInteger(minimumItems) ||
    minimumItems < 0 ||
    minimumItems > originalItems.length
  ) {
    throw new Error("shrink minimumItems is outside the original sequence");
  }
  const mayAttempt = (): boolean =>
    attempts < maxAttempts &&
    (options.deadlineMs === undefined || Date.now() < options.deadlineMs);
  const check = async (candidate: readonly T[]): Promise<boolean> => {
    if (!mayAttempt()) return false;
    attempts += 1;
    return reproduces(candidate);
  };

  let items = [...originalItems];
  if (!options.assumeOriginalReproduces && !(await check(items))) {
    throw new Error(
      "cannot shrink a sequence that does not reproduce the failure",
    );
  }

  let granularity = 2;
  while (items.length > 0 && mayAttempt()) {
    const chunkSize = Math.ceil(items.length / granularity);
    let reduced = false;
    for (
      let start = 0;
      start < items.length && mayAttempt();
      start += chunkSize
    ) {
      const candidate = [
        ...items.slice(0, start),
        ...items.slice(Math.min(items.length, start + chunkSize)),
      ];
      if (candidate.length < minimumItems) continue;
      if (await check(candidate)) {
        items = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= items.length) break;
    granularity = Math.min(items.length, granularity * 2);
  }

  return {
    items,
    attempts,
    budgetExhausted: !mayAttempt(),
  };
}

export function parseGeneratedFailureArtifact(
  value: unknown,
): GeneratedFailureArtifact {
  const root = requireRecord(value, "generated failure artifact");
  if (root.schemaVersion !== GENERATED_FAILURE_SCHEMA_VERSION) {
    throw new Error(
      `generated failure schemaVersion must be ${GENERATED_FAILURE_SCHEMA_VERSION}`,
    );
  }
  if (
    !Array.isArray(root.reducedRandomWords) ||
    root.reducedRandomWords.length === 0
  ) {
    throw new Error("generated failure reducedRandomWords must be non-empty");
  }
  if (!Array.isArray(root.actionTrace)) {
    throw new Error("generated failure actionTrace must be an array");
  }
  const artifact: GeneratedFailureArtifact = {
    schemaVersion: GENERATED_FAILURE_SCHEMA_VERSION,
    caseId: requireNonEmptyString(root.caseId, "generated failure caseId"),
    sourceSeed: formatUint32Seed(
      parseUint32Seed(
        requireNonEmptyString(root.sourceSeed, "generated failure sourceSeed"),
      ),
    ),
    failureFingerprint: requireNonEmptyString(
      root.failureFingerprint,
      "generated failure failureFingerprint",
    ),
    originalRandomWordCount: requirePositiveInteger(
      root.originalRandomWordCount,
      "generated failure originalRandomWordCount",
    ),
    reducedRandomWords: root.reducedRandomWords.map((word, index) =>
      requireUint32(word, `generated failure reducedRandomWords[${index}]`),
    ),
    openActionCount: requirePositiveInteger(
      root.openActionCount,
      "generated failure openActionCount",
    ),
    actionTrace: root.actionTrace.map((action, index) =>
      requireNonEmptyString(action, `generated failure actionTrace[${index}]`),
    ),
  };
  if (artifact.reducedRandomWords.length > artifact.originalRandomWordCount) {
    throw new Error(
      "generated failure reduction is larger than the original tape",
    );
  }
  return artifact;
}

export function promoteGeneratedFailure(
  corpus: GeneratedStateMachineCorpus,
  artifact: GeneratedFailureArtifact,
  replayId: string,
): GeneratedStateMachineCorpus {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(replayId)) {
    throw new Error(`generated replay id is not canonical: ${replayId}`);
  }
  if (corpus.cases.some((entry) => entry.id === replayId)) {
    throw new Error(`generated replay id already exists: ${replayId}`);
  }
  const duplicate = corpus.cases.find(
    (entry) =>
      entry.kind === "replay" &&
      entry.historicalFailureFingerprint === artifact.failureFingerprint &&
      JSON.stringify(entry.randomWords) ===
        JSON.stringify(artifact.reducedRandomWords),
  );
  if (duplicate) {
    throw new Error(`generated failure is already promoted as ${duplicate.id}`);
  }
  return {
    ...corpus,
    cases: [
      ...corpus.cases,
      {
        id: replayId,
        kind: "replay",
        sourceSeed: artifact.sourceSeed,
        randomWords: [...artifact.reducedRandomWords],
        openActionCount: artifact.openActionCount,
        enforceCoverage: false,
        historicalFailureFingerprint: artifact.failureFingerprint,
      },
    ],
  };
}
