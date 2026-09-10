export function exactBytes32(value: unknown): Uint8Array | null {
  try {
    const entries =
      value instanceof Uint8Array
        ? Array.from(value)
        : Array.isArray(value)
          ? value
          : null;
    if (
      !entries ||
      entries.length !== 32 ||
      entries.some(
        (entry) =>
          typeof entry !== "number" ||
          !Number.isInteger(entry) ||
          entry < 0 ||
          entry > 255,
      )
    ) {
      return null;
    }
    return Uint8Array.from(entries);
  } catch {
    return null;
  }
}

export function exactBytes32Hex(value: unknown): string | null {
  const bytes = exactBytes32(value);
  return bytes ? Buffer.from(bytes).toString("hex") : null;
}
