import { decodeValue, encodeValue } from "./value-codec.mjs";

const string = value => typeof value === "string";
const number = value => typeof value === "number" && Number.isFinite(value);
const optional = check => value => value === undefined || check(value);
const nullable = check => value => value === null || check(value);
const oneOf = (...values) => value => values.includes(value);
const record = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fields = schema => value => record(value) && Object.entries(schema)
  .every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const rating = fields({ mu: number, sigma: number, gamesPlayed: number });
const status = oneOf("ACTIVE", "CLOSE_ONLY", "ARCHIVED");
const schemas = Object.freeze({
  loadAll: [optional(number)],
  saveBet: [fields({ id: string, bettorWallet: string, chain: oneOf("SOLANA", "BSC", "BASE"),
    sourceAsset: string, sourceAmount: number, goldAmount: number, feeBps: number,
    txSignature: string, marketPda: nullable(string), inviteCode: nullable(string),
    externalBetRef: nullable(string), recordedAt: number })],
  saveWalletDisplay: [string, string],
  saveWalletPoints: [string, fields({ selfPoints: number, winPoints: number, referralPoints: number, stakingPoints: number })],
  savePointsEvent: [fields({ wallet: string, eventType: string, status: string, totalPoints: number,
    referenceType: nullable(string), referenceId: nullable(string), relatedWallet: nullable(string), createdAt: number })],
  saveWalletGoldState: [string, fields({ goldBalance: number, goldHoldDays: number, updatedAt: number })],
  saveWalletCanonical: [string, string],
  saveIdentityMembers: [string, value => value instanceof Set && [...value].every(string)],
  deleteIdentityMembers: [string],
  saveInviteCode: [string, string],
  saveReferral: [string, string, string],
  saveInvitedWallet: [string, string],
  saveReferralFees: [string, number, number],
  loadAgentRatings: [],
  loadPerpsOracleSnapshots: [optional(string), optional(number)],
  loadPerpsMarkets: [optional(status)],
  saveAgentRating: [string, rating, optional(number)],
  saveAgentRatings: [value => record(value) && Object.values(value).every(rating), optional(number)],
  savePerpsOracleSnapshot: [fields({ agentId: string, marketId: number, spotIndex: number,
    conservativeSkill: number, mu: number, sigma: number, recordedAt: number })],
  savePerpsMarket: [fields({ agentId: string, marketId: number, rank: nullable(number), name: string,
    provider: string, model: string, wins: number, losses: number, winRate: number,
    combatLevel: number, currentStreak: number, status, lastSeenAt: number,
    deprecatedAt: nullable(number), updatedAt: number })],
});

export function validateOperation(operation, args) {
  if (typeof operation !== "string" || !Object.hasOwn(schemas, operation) || !Array.isArray(args)) return false;
  const schema = schemas[operation];
  return args.length <= schema.length && schema.every((check, index) => check(args[index]));
}

async function authenticated(request, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return false;
  const supplied = request.headers.get("authorization") ?? "";
  const encoder = new TextEncoder();
  const hashes = await Promise.all([supplied, `Bearer ${token}`].map(value =>
    crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

/** execute must atomically enforce admission, perform SQL, and record its receipt. */
export async function handleStorageRequest(request, { token, execute }) {
  const reject = (message, status) => new Response(message, { status, headers: { "cache-control": "no-store" } });
  if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return reject("Not found", 404);
  if (!await authenticated(request, token)) return reject("Unauthorized", 401);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return reject("JSON required", 415);
  let payload, args;
  try {
    payload = await request.json();
    if (!record(payload) || Object.keys(payload).sort().join(",") !== "args,operation,requestId" ||
        typeof payload.requestId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.requestId) ||
        !Array.isArray(payload.args)) throw new Error("Invalid request");
    args = payload.args.map(decodeValue);
    if (!validateOperation(payload.operation, args)) throw new Error("Invalid operation");
  } catch { return reject("Invalid storage request", 400); }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify({ operation: payload.operation, args: payload.args }),
    ));
    const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const value = execute(payload.requestId, payload.operation, args, fingerprint);
    if (value && typeof value.then === "function") throw new Error("Storage execution must be synchronous");
    return Response.json({ requestId: payload.requestId, ok: true, value: encodeValue(value) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch { return reject("Storage operation rejected", 409); }
}
