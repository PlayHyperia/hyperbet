import assert from "node:assert/strict";
import { handleStorageRequest, validateOperation } from "../storage-request.mjs";
import { encodeValue, decodeValue } from "../value-codec.mjs";

const rating = { mu: 100, sigma: 5, gamesPlayed: 2 };
const cases = {
  loadAll: [],
  saveBet: [{ id: "bet", bettorWallet: "wallet", chain: "SOLANA", sourceAsset: "GOLD", sourceAmount: 1,
    goldAmount: 1, feeBps: 10, txSignature: "fixture", marketPda: null, inviteCode: null, externalBetRef: null, recordedAt: 100 }],
  saveWalletDisplay: ["wallet", "Fixture"],
  saveWalletPoints: ["wallet", { selfPoints: 1, winPoints: 2, referralPoints: 3, stakingPoints: 4 }],
  savePointsEvent: [{ wallet: "wallet", eventType: "fixture", status: "CONFIRMED", totalPoints: 1,
    referenceType: null, referenceId: null, relatedWallet: null, createdAt: 100 }],
  saveWalletGoldState: ["wallet", { goldBalance: 5, goldHoldDays: 1, updatedAt: 100 }],
  saveWalletCanonical: ["wallet", "canonical"], saveIdentityMembers: ["canonical", new Set(["wallet"])],
  deleteIdentityMembers: ["canonical"], saveInviteCode: ["wallet", "code"],
  saveReferral: ["wallet", "referrer", "code"], saveInvitedWallet: ["wallet", "invitee"],
  saveReferralFees: ["wallet", 1, 2], loadAgentRatings: [],
  loadPerpsOracleSnapshots: [undefined, 100], loadPerpsMarkets: ["ACTIVE"],
  saveAgentRating: ["agent", rating], saveAgentRatings: [{ agent: rating }],
  savePerpsOracleSnapshot: [{ agentId: "agent", marketId: 1, spotIndex: 1, conservativeSkill: 1, mu: 100, sigma: 5, recordedAt: 100 }],
  savePerpsMarket: [{ agentId: "agent", marketId: 1, rank: null, name: "Fixture", provider: "fixture", model: "fixture",
    wins: 1, losses: 1, winRate: 50, combatLevel: 1, currentStreak: 0, status: "ACTIVE", lastSeenAt: 100,
    deprecatedAt: null, updatedAt: 100 }],
};
const token = "a".repeat(32);
let calls = 0;
const execute = (_id, operation, args) => {
  calls++;
  assert.deepEqual(args, cases[operation]);
  return new Map([["result", { members: new Set(["wallet"]), optional: undefined }]]);
};
function request(payload, headers = {}, url = "https://fixture.invalid/rpc") {
  return new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
}
function payload(operation, args = cases[operation]) {
  return { requestId: crypto.randomUUID(), operation, args: args.map(encodeValue) };
}
assert.equal(Object.keys(cases).length, 20);
for (const [operation, args] of Object.entries(cases)) {
  assert.equal(validateOperation(operation, args), true, operation);
  const body = payload(operation);
  const response = await handleStorageRequest(request(body), { token, execute });
  assert.equal(response.status, 200, operation);
  const result = await response.json();
  assert.equal(result.requestId, body.requestId);
  assert.deepEqual(decodeValue(result.value), new Map([["result", { members: new Set(["wallet"]), optional: undefined }]]));
}
for (const [operation, args] of [["constructor", []], ["saveReferral", ["wallet"]],
  ["saveIdentityMembers", ["wallet", ["member"]]], ["saveAgentRating", ["agent", { ...rating, mu: null }]],
  ["loadPerpsMarkets", ["INVALID"]], ["loadAgentRatings", [1]], ["saveWalletDisplay", [null, "display"]]]) {
  assert.equal((await handleStorageRequest(request(payload(operation, args)), { token, execute })).status, 400);
}
assert.equal((await handleStorageRequest(request(payload("loadAll"), { authorization: "Bearer wrong" }), { token, execute })).status, 401);
assert.equal((await handleStorageRequest(request(payload("loadAll"), { "content-type": "text/plain" }), { token, execute })).status, 415);
assert.equal((await handleStorageRequest(request(payload("loadAll"), {}, "https://fixture.invalid/admin"), { token, execute })).status, 404);
assert.equal((await handleStorageRequest(request({ ...payload("loadAll"), requestId: "wrong" }), { token, execute })).status, 400);
assert.equal(calls, 20, "invalid requests must not reach storage");
const failed = await handleStorageRequest(request(payload("loadAll")), { token, execute() { throw new Error("private details"); } });
assert.equal(failed.status, 409);
assert.equal(await failed.text(), "Storage operation rejected");
console.log("Authenticated storage API: all 20 operation shapes, collections, authorization, and invalid input passed");
