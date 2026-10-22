const invalid = () => { throw new Error("Invalid keeper runtime configuration"); };
const token = value => typeof value === "string" && /^[A-Za-z0-9_-]{32,}$/.test(value);

export function buildRuntimeEnv(env) {
  if (!token(env.KEEPER_STORAGE_TOKEN) || !token(env.KEEPER_ADMIN_TOKEN) ||
      env.KEEPER_STORAGE_TOKEN === env.KEEPER_ADMIN_TOKEN) invalid();
  let origin, settings;
  try {
    origin = new URL(env.KEEPER_PUBLIC_ORIGIN);
    settings = JSON.parse(env.KEEPER_RUNTIME_CONFIG);
  } catch { invalid(); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== "/" || origin.port || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(origin.hostname) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(origin.hostname)) invalid();
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) invalid();
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) invalid();
    if (key.startsWith("RAILWAY_") || ["PORT", "NODE_ENV", "KEEPER_DB_PATH"].includes(key)) continue;
    if (key.startsWith("KEEPER_STORAGE_") || key.startsWith("KEEPER_SUPERVISOR_") ||
        ["KEEPER_PROCESS_GROUP_ID", "KEEPER_ADMIN_TOKEN"].includes(key)) invalid();
    // Railway's private DNS is inaccessible from the Cloudflare container.
    if (/(?:^|[./])railway\.internal(?=[:/]|$)/i.test(value)) invalid();
    result[key] = value;
  }
  return { ...result, PORT: "8080", NODE_ENV: "production",
    KEEPER_STORAGE_URL: `${origin.origin}/rpc`, KEEPER_STORAGE_TOKEN: env.KEEPER_STORAGE_TOKEN };
}
