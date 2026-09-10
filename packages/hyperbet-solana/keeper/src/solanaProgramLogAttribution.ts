export type AttributedProgramDataLogs = {
  programData: string[];
  invocationCount: number;
};

const BASE58_PROGRAM_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROGRAM_INVOKE =
  /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[([1-9][0-9]*)\]$/;
const PROGRAM_TERMINAL =
  /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed(?::.*)?)$/;
const PROGRAM_DATA_PREFIX = "Program data: ";

export function extractAttributedProgramDataLogs(
  logMessages: readonly string[],
  programId: string,
): AttributedProgramDataLogs {
  if (!BASE58_PROGRAM_ID.test(programId)) {
    throw new Error("program log attribution target is invalid");
  }

  const invocationStack: string[] = [];
  const programData: string[] = [];
  let invocationCount = 0;

  for (const log of logMessages) {
    if (log.includes("Log truncated")) {
      throw new Error("program log evidence is truncated");
    }

    const invoke = PROGRAM_INVOKE.exec(log);
    if (invoke) {
      const invokedProgram = invoke[1];
      const depth = Number(invoke[2]);
      if (
        !invokedProgram ||
        !Number.isSafeInteger(depth) ||
        depth !== invocationStack.length + 1
      ) {
        throw new Error("program invocation log stack is inconsistent");
      }
      invocationStack.push(invokedProgram);
      if (invokedProgram === programId) invocationCount += 1;
      continue;
    }

    if (log.startsWith(PROGRAM_DATA_PREFIX)) {
      const activeProgram = invocationStack.at(-1);
      if (!activeProgram) {
        throw new Error("program data log has no active invocation");
      }
      if (activeProgram === programId) {
        programData.push(log.slice(PROGRAM_DATA_PREFIX.length));
      }
      continue;
    }

    const terminal = PROGRAM_TERMINAL.exec(log);
    if (terminal) {
      const completedProgram = terminal[1];
      if (!completedProgram || invocationStack.at(-1) !== completedProgram) {
        throw new Error("program terminal log stack is inconsistent");
      }
      invocationStack.pop();
    }
  }

  if (invocationStack.length !== 0) {
    throw new Error("program invocation log stack is incomplete");
  }

  return { programData, invocationCount };
}
