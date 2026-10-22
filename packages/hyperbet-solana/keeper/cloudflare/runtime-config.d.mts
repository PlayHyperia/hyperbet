export function buildRuntimeEnv(env: {
  KEEPER_STORAGE_TOKEN: string;
  KEEPER_ADMIN_TOKEN: string;
  KEEPER_PUBLIC_ORIGIN: string;
  KEEPER_RUNTIME_CONFIG: string;
}): Record<string, string>;
