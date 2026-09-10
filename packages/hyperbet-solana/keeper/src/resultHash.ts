import { createHash } from "node:crypto";

export const RESULT_HASH_DOMAIN = "hyperia-duel-result-v2";

const UINT_DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U32 = 0xffff_ffff;

function hashBytes(value: string, label: string): Buffer {
  if (value.trim() !== value) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
  const normalized = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 32-byte hex string`);
  }
  return Buffer.from(normalized, "hex");
}

function nonzeroHashBytes(value: string, label: string): Buffer {
  const bytes = hashBytes(value, label);
  if (bytes.every((byte) => byte === 0)) {
    throw new Error(`${label} must not be all zero`);
  }
  return bytes;
}

function seedBytes(value: string): Buffer {
  if (!UINT_DECIMAL.test(value)) {
    throw new Error("seed must be a canonical unsigned decimal integer");
  }
  const seed = BigInt(value);
  if (seed > MAX_U64) {
    throw new Error("seed exceeds the unsigned 64-bit range");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(seed);
  return bytes;
}

function snapshotVersionBytes(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_U32) {
    throw new Error(
      "competitive snapshot version must be a positive unsigned 32-bit integer",
    );
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

export function buildResultHash(
  duelKeyHex: string,
  winnerSide: "A" | "B",
  seed: string,
  replayHashHex: string,
  competitiveSnapshotVersion: number,
  competitiveSnapshotDigestHex: string,
): number[] {
  const winnerTag = winnerSide === "A" ? 1 : winnerSide === "B" ? 2 : 0;
  if (winnerTag === 0) {
    throw new Error("winner side must be A or B");
  }

  return Array.from(
    createHash("sha256")
      .update(RESULT_HASH_DOMAIN, "ascii")
      .update(hashBytes(duelKeyHex, "duel key"))
      .update(Buffer.from([winnerTag]))
      .update(seedBytes(seed))
      .update(nonzeroHashBytes(replayHashHex, "replay hash"))
      .update(snapshotVersionBytes(competitiveSnapshotVersion))
      .update(
        nonzeroHashBytes(
          competitiveSnapshotDigestHex,
          "competitive snapshot digest",
        ),
      )
      .digest(),
  );
}
