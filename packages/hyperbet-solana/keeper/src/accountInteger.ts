const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;

function integerText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  try {
    const stringify = (value as { toString?: unknown }).toString;
    if (typeof stringify !== "function") return null;
    const text = stringify.call(value);
    return typeof text === "string" && /^(?:0|-?[1-9]\d*)$/.test(text)
      ? text
      : null;
  } catch {
    return null;
  }
}

function accountIntegerBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }

  const text = integerText(value);
  if (text === null) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

export function safeAccountInteger(value: unknown): number | null {
  const parsed = accountIntegerBigInt(value);
  if (parsed === null) return null;
  if (parsed < MIN_SAFE_BIGINT || parsed > MAX_SAFE_BIGINT) {
    return null;
  }
  return Number(parsed);
}

export function accountU64(value: unknown): bigint | null {
  const parsed = accountIntegerBigInt(value);
  return parsed !== null && parsed >= 0n && parsed <= MAX_U64 ? parsed : null;
}

export function requireAccountU64(value: unknown, label: string): bigint {
  const parsed = accountU64(value);
  if (parsed === null) {
    throw new Error(`${label} is not a canonical u64`);
  }
  return parsed;
}

export function requireSafeAccountInteger(
  value: unknown,
  label: string,
  bounds: { min?: number; max?: number } = {},
): number {
  if (
    (bounds.min !== undefined && !Number.isSafeInteger(bounds.min)) ||
    (bounds.max !== undefined && !Number.isSafeInteger(bounds.max)) ||
    (bounds.min !== undefined &&
      bounds.max !== undefined &&
      bounds.min > bounds.max)
  ) {
    throw new Error(`${label} has invalid safe-integer bounds`);
  }
  const parsed = safeAccountInteger(value);
  if (parsed === null) {
    throw new Error(`${label} is not a safe integer`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new Error(`${label} is below ${bounds.min}`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`${label} exceeds ${bounds.max}`);
  }
  return parsed;
}
