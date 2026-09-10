const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
const CANONICAL_U64 = /^(?:0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;

export function toSafeIntegerLike(value: unknown): number | null {
  try {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && !Object.is(value, -0)
        ? value
        : null;
    }
    if (typeof value === "bigint") {
      return value >= MIN_SAFE_INTEGER_BIGINT &&
        value <= MAX_SAFE_INTEGER_BIGINT
        ? Number(value)
        : null;
    }
    if (typeof value === "string") {
      if (!CANONICAL_INTEGER.test(value)) return null;
      const parsed = BigInt(value);
      return parsed >= MIN_SAFE_INTEGER_BIGINT &&
        parsed <= MAX_SAFE_INTEGER_BIGINT
        ? Number(parsed)
        : null;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "toNumber" in value &&
      typeof (value as { toNumber?: unknown }).toNumber === "function"
    ) {
      const parsed = (value as { toNumber(): unknown }).toNumber();
      return typeof parsed === "number" &&
        Number.isSafeInteger(parsed) &&
        !Object.is(parsed, -0)
        ? parsed
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function toU64Like(value: unknown): bigint | null {
  try {
    let parsed: bigint;
    if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        return null;
      }
      parsed = BigInt(value);
    } else if (typeof value === "string") {
      if (!CANONICAL_U64.test(value)) return null;
      parsed = BigInt(value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      "toString" in value &&
      typeof (value as { toString?: unknown }).toString === "function"
    ) {
      const rendered = (value as { toString(): unknown }).toString();
      if (typeof rendered !== "string" || !CANONICAL_U64.test(rendered)) {
        return null;
      }
      parsed = BigInt(rendered);
    } else {
      return null;
    }
    return parsed >= 0n && parsed <= U64_MAX ? parsed : null;
  } catch {
    return null;
  }
}
