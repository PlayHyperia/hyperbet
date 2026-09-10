import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  parseOperatorAlertDurableState,
  type OperatorAlertDurableState,
} from "./operatorAlertDispatcher";

const MAX_STATE_BYTES = 64 * 1024;

export function loadOperatorAlertDurableState(input: {
  statePath: string;
  routeId: string;
}): OperatorAlertDurableState | null {
  let stateStat: ReturnType<typeof lstatSync>;
  try {
    stateStat = lstatSync(input.statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("operator alert state file is invalid");
  }
  if (
    !stateStat.isFile() ||
    stateStat.size <= 0 ||
    stateStat.size > MAX_STATE_BYTES ||
    (stateStat.mode & 0o077) !== 0
  ) {
    throw new Error("operator alert state file is invalid");
  }
  let stateDescriptor: number | null = null;
  let parsedJson: unknown;
  try {
    stateDescriptor = openSync(
      input.statePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStat = fstatSync(stateDescriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== stateStat.dev ||
      openedStat.ino !== stateStat.ino ||
      openedStat.size !== stateStat.size ||
      (openedStat.mode & 0o077) !== 0
    ) {
      throw new Error("operator alert state file is invalid");
    }
    parsedJson = JSON.parse(readFileSync(stateDescriptor, "utf8"));
  } catch {
    throw new Error("operator alert state file is invalid");
  } finally {
    if (stateDescriptor !== null) closeSync(stateDescriptor);
  }
  const state = parseOperatorAlertDurableState(parsedJson, input.routeId);
  if (!state) {
    throw new Error("operator alert state file is invalid");
  }
  return state;
}

export function persistOperatorAlertDurableState(
  statePath: string,
  state: OperatorAlertDurableState,
): void {
  const parsed = parseOperatorAlertDurableState(state, state.routeId);
  if (!parsed) {
    throw new Error("refusing to persist invalid operator alert state");
  }
  const resolvedPath = path.resolve(statePath);
  const parent = path.dirname(resolvedPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    parent,
    `.${path.basename(resolvedPath)}.${randomUUID()}.tmp`,
  );
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(
      fileDescriptor,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    renameSync(temporaryPath, resolvedPath);
    chmodSync(resolvedPath, 0o600);
    const directoryDescriptor = openSync(parent, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A successful atomic rename consumes the temporary path.
    }
  }
}
