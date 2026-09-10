export function shouldExposeSolanaDebugSurface(input: {
  isE2eMode: boolean;
  search: string;
}): boolean {
  return input.isE2eMode && new URLSearchParams(input.search).has("debug");
}
