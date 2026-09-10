export type SolanaPagesBundleManifest = Readonly<{
  schemaVersion: 1;
  artifactCount: number;
  manifestSha256: string;
}>;

export function resolveSolanaPagesBundleManifest(
  rootPath: string,
): SolanaPagesBundleManifest;
