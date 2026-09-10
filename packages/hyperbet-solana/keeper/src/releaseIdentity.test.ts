import { describe, expect, test } from "bun:test";

import {
  normalizeReleaseCommitSha,
  resolveKeeperReleaseIdentity,
} from "./releaseIdentity";

const manifestSha = "a".repeat(40);
const environmentSha = "b".repeat(40);

describe("keeper release identity", () => {
  test("accepts only a full lowercase commit SHA", () => {
    expect(normalizeReleaseCommitSha(manifestSha)).toBe(manifestSha);
    expect(normalizeReleaseCommitSha(` ${manifestSha} `)).toBe(manifestSha);
    expect(normalizeReleaseCommitSha("A".repeat(40))).toBeNull();
    expect(normalizeReleaseCommitSha("a".repeat(39))).toBeNull();
    expect(normalizeReleaseCommitSha(null)).toBeNull();
  });

  test("prefers the build-baked manifest over mutable runtime state", () => {
    expect(
      resolveKeeperReleaseIdentity(
        { schemaVersion: 1, commitSha: manifestSha },
        environmentSha,
      ),
    ).toEqual({ commitSha: manifestSha, source: "manifest" });
  });

  test("uses an environment SHA for local and pre-deploy smoke tests", () => {
    expect(
      resolveKeeperReleaseIdentity(
        { schemaVersion: 1, commitSha: null },
        environmentSha,
      ),
    ).toEqual({ commitSha: environmentSha, source: "environment" });
  });

  test("fails visibly when neither release source is valid", () => {
    expect(resolveKeeperReleaseIdentity({}, "branch-name")).toEqual({
      commitSha: null,
      source: "unavailable",
    });
  });
});
