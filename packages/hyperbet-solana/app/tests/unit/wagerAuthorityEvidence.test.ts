import { describe, expect, test } from "bun:test";
import { isCaptureViewerAuthorityRevoked } from "../e2e/wagerAuthorityEvidence";

const authority = {
  duelId: "streaming-938f80e5-44ed-4c87-a143-85dfc6c84fc2",
  duelKey: "a".repeat(64),
};
const viewer = {
  marketDuelId: authority.duelId,
  marketDuelKey: authority.duelKey,
  streamDuelId: authority.duelId,
  streamDuelKey: authority.duelKey,
  canPlaceBet: "false",
  dialogCount: 0,
  submitPresent: 0,
  submitDisabled: 0,
};

describe("capture viewer evidence contract", () => {
  test("permits read-only removal and exact paired delayed identity", () => {
    for (const presentation of [
      {},
      { streamDuelId: null, streamDuelKey: null },
    ]) {
      for (const counts of [
        { submitPresent: 0, submitDisabled: 0 },
        { submitPresent: 1, submitDisabled: 1 },
        { submitPresent: 2, submitDisabled: 2 },
      ])
        expect(
          isCaptureViewerAuthorityRevoked(
            { ...viewer, ...presentation, ...counts },
            authority,
          ),
        ).toBe(true);
    }
  });

  test("rejects active authority, stale confirmation, crossed identity and any enabled duplicate", () => {
    for (const invalid of [
      { canPlaceBet: "true", submitPresent: 1, submitDisabled: 1 },
      { dialogCount: 1 },
      { marketDuelId: null },
      { marketDuelKey: "b".repeat(64) },
      { streamDuelId: null },
      { streamDuelKey: null },
      { streamDuelId: "other-duel" },
      { streamDuelKey: "b".repeat(64) },
      { submitPresent: 1, submitDisabled: 0 },
      { submitPresent: 2, submitDisabled: 1 },
      { submitPresent: -1, submitDisabled: -1 },
      { submitPresent: 0.5, submitDisabled: 0.5 },
      { submitPresent: "0", submitDisabled: "0" },
      { submitPresent: 129, submitDisabled: 129 },
    ])
      expect(
        isCaptureViewerAuthorityRevoked({ ...viewer, ...invalid }, authority),
      ).toBe(false);
    for (const invalid of [null, undefined, [], {}, "false"]) {
      expect(isCaptureViewerAuthorityRevoked(invalid, authority)).toBe(false);
    }
  });
});
