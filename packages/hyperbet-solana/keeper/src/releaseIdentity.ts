export type KeeperReleaseIdentitySource =
  | "manifest"
  | "environment"
  | "unavailable";

export interface KeeperReleaseIdentity {
  commitSha: string | null;
  source: KeeperReleaseIdentitySource;
}

const fullCommitSha = /^[0-9a-f]{40}$/u;

export function normalizeReleaseCommitSha(value: unknown): string | null {
  return typeof value === "string" && fullCommitSha.test(value.trim())
    ? value.trim()
    : null;
}

export function resolveKeeperReleaseIdentity(
  manifest: unknown,
  environmentCommitSha: unknown,
): KeeperReleaseIdentity {
  const manifestCommitSha =
    manifest && typeof manifest === "object"
      ? normalizeReleaseCommitSha(
          (manifest as { commitSha?: unknown }).commitSha,
        )
      : null;
  if (manifestCommitSha) {
    return { commitSha: manifestCommitSha, source: "manifest" };
  }

  const environmentSha = normalizeReleaseCommitSha(environmentCommitSha);
  if (environmentSha) {
    return { commitSha: environmentSha, source: "environment" };
  }
  return { commitSha: null, source: "unavailable" };
}
