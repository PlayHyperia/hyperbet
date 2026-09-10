export type ExactDecodedProgramEvent = {
  name: string;
  data: Record<string, unknown>;
};

export function decodeExactProgramDataEvents(
  programData: unknown,
  decode: (value: string) => unknown,
): ExactDecodedProgramEvent[] {
  if (!Array.isArray(programData)) {
    throw new Error("program data logs must be an array");
  }
  const events: ExactDecodedProgramEvent[] = [];
  for (const value of programData) {
    if (typeof value !== "string" || !value) {
      throw new Error("program data log is not canonical text");
    }
    const decoded = decode(value);
    if (typeof decoded !== "object" || decoded === null) {
      throw new Error("program data log did not decode");
    }
    const event = decoded as { name?: unknown; data?: unknown };
    if (
      typeof event.name !== "string" ||
      !event.name ||
      typeof event.data !== "object" ||
      event.data === null ||
      Array.isArray(event.data)
    ) {
      throw new Error("program data log decoded to an invalid event");
    }
    events.push({
      name: event.name,
      data: event.data as Record<string, unknown>,
    });
  }
  return events;
}
