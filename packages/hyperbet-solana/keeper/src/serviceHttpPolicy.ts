import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

const MAX_ORIGIN_LENGTH = 2_048;
const MAX_CONFIGURED_ORIGINS = 32;
const MAX_TRUSTED_PROXIES = 32;
const MAX_FORWARDED_HEADER_LENGTH = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const REVIEWED_PRODUCTION_ORIGINS = new Set([
  "https://hyperbet.win",
  "https://www.hyperbet.win",
  "https://hyperia.gg",
  "https://www.hyperia.gg",
  "https://hyperia.club",
  "https://www.hyperia.club",
]);

const REVIEWED_PAGES_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?hyperbet\.pages\.dev$/u;

export class ServiceHttpPolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceHttpPolicyConfigurationError";
  }
}

export type TrustedProxyPolicy =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "allowlist"; entries: readonly string[]; blockList: BlockList };

export type ServiceHttpPolicy = {
  deployment: boolean;
  configuredOrigins: ReadonlySet<string>;
  trustedProxy: TrustedProxyPolicy;
  rateLimitDisabled: boolean;
};

function isDeploymentEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.NODE_ENV === "production" || environment.NODE_ENV === "staging"
  );
}

function normalizeExactOrigin(value: string, deployment: boolean): string {
  if (
    value.length === 0 ||
    value.length > MAX_ORIGIN_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    value.trim() !== value ||
    value.includes(",")
  ) {
    throw new ServiceHttpPolicyConfigurationError(
      "CORS_ORIGINS contains a malformed origin",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServiceHttpPolicyConfigurationError(
      "CORS_ORIGINS contains an invalid URL",
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new ServiceHttpPolicyConfigurationError(
      "CORS_ORIGINS entries must be exact HTTP(S) origins without credentials, paths, query strings, fragments, or trailing slashes",
    );
  }
  if (deployment && parsed.protocol !== "https:") {
    throw new ServiceHttpPolicyConfigurationError(
      "CORS_ORIGINS entries must use HTTPS in production and staging",
    );
  }
  return parsed.origin;
}

function resolveConfiguredOrigins(
  environment: NodeJS.ProcessEnv,
  deployment: boolean,
): ReadonlySet<string> {
  const raw = environment.CORS_ORIGINS;
  if (raw == null || raw.trim() === "") return new Set();
  if (raw.length > MAX_CONFIGURED_ORIGINS * MAX_ORIGIN_LENGTH) {
    throw new ServiceHttpPolicyConfigurationError("CORS_ORIGINS is too large");
  }
  const values = raw.split(",");
  if (
    values.length < 1 ||
    values.length > MAX_CONFIGURED_ORIGINS ||
    values.some((value) => value.length === 0)
  ) {
    throw new ServiceHttpPolicyConfigurationError(
      `CORS_ORIGINS must contain between 1 and ${MAX_CONFIGURED_ORIGINS} exact origins`,
    );
  }
  const normalized = values.map((value) =>
    normalizeExactOrigin(value, deployment),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new ServiceHttpPolicyConfigurationError(
      "CORS_ORIGINS must not contain duplicate origins",
    );
  }
  return new Set(normalized);
}

function addTrustedProxyEntry(blockList: BlockList, entry: string): void {
  const slashIndex = entry.indexOf("/");
  const address = slashIndex === -1 ? entry : entry.slice(0, slashIndex);
  const version = isIP(address);
  if (version === 0) {
    throw new ServiceHttpPolicyConfigurationError(
      `HYPERBET_TRUST_PROXY contains an invalid IP address or CIDR: ${entry}`,
    );
  }
  const family = version === 4 ? "ipv4" : "ipv6";
  if (slashIndex === -1) {
    blockList.addAddress(address, family);
    return;
  }
  if (entry.indexOf("/", slashIndex + 1) !== -1) {
    throw new ServiceHttpPolicyConfigurationError(
      `HYPERBET_TRUST_PROXY contains an invalid CIDR: ${entry}`,
    );
  }
  const prefix = entry.slice(slashIndex + 1);
  if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(prefix)) {
    throw new ServiceHttpPolicyConfigurationError(
      `HYPERBET_TRUST_PROXY contains an invalid CIDR prefix: ${entry}`,
    );
  }
  const prefixNumber = Number(prefix);
  if (prefixNumber > (version === 4 ? 32 : 128)) {
    throw new ServiceHttpPolicyConfigurationError(
      `HYPERBET_TRUST_PROXY contains an invalid CIDR prefix: ${entry}`,
    );
  }
  blockList.addSubnet(address, prefixNumber, family);
}

function resolveTrustedProxy(
  environment: NodeJS.ProcessEnv,
  deployment: boolean,
): TrustedProxyPolicy {
  const raw = environment.HYPERBET_TRUST_PROXY;
  const normalized = raw?.trim().toLowerCase();
  if (raw == null || normalized === "" || normalized === "false") {
    return { mode: "none" };
  }
  if (normalized === "true") {
    if (deployment) {
      throw new ServiceHttpPolicyConfigurationError(
        "HYPERBET_TRUST_PROXY=true is forbidden in production and staging",
      );
    }
    return { mode: "all" };
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    throw new ServiceHttpPolicyConfigurationError(
      "HYPERBET_TRUST_PROXY must not contain control characters",
    );
  }
  const entries = raw.split(",").map((entry) => entry.trim());
  if (
    entries.length < 1 ||
    entries.length > MAX_TRUSTED_PROXIES ||
    entries.some((entry) => entry.length === 0)
  ) {
    throw new ServiceHttpPolicyConfigurationError(
      `HYPERBET_TRUST_PROXY must contain between 1 and ${MAX_TRUSTED_PROXIES} exact IP addresses or CIDRs`,
    );
  }
  if (new Set(entries).size !== entries.length) {
    throw new ServiceHttpPolicyConfigurationError(
      "HYPERBET_TRUST_PROXY must not contain duplicate entries",
    );
  }
  const blockList = new BlockList();
  for (const entry of entries) addTrustedProxyEntry(blockList, entry);
  return { mode: "allowlist", entries, blockList };
}

function readStrictBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function resolveServiceHttpPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceHttpPolicy {
  const deployment = isDeploymentEnvironment(environment);
  const rateLimitDisabled = readStrictBoolean(environment.DISABLE_RATE_LIMIT);
  if (deployment && rateLimitDisabled) {
    throw new ServiceHttpPolicyConfigurationError(
      "DISABLE_RATE_LIMIT cannot be enabled in production or staging",
    );
  }
  return {
    deployment,
    configuredOrigins: resolveConfiguredOrigins(environment, deployment),
    trustedProxy: resolveTrustedProxy(environment, deployment),
    rateLimitDisabled,
  };
}

function isLocalDevelopmentOrigin(parsed: URL): boolean {
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^10\./u.test(hostname) ||
    /^192\.168\./u.test(hostname)
  ) {
    return true;
  }
  const private172 = hostname.match(/^172\.(\d{1,3})\./u);
  return (
    private172 != null &&
    Number(private172[1]) >= 16 &&
    Number(private172[1]) <= 31
  );
}

export function isAllowedAppOrigin(
  rawOrigin: string | null,
  policy: ServiceHttpPolicy,
): boolean {
  if (
    rawOrigin == null ||
    rawOrigin.length === 0 ||
    rawOrigin.length > MAX_ORIGIN_LENGTH ||
    rawOrigin.trim() !== rawOrigin ||
    rawOrigin.includes(",") ||
    CONTROL_CHARACTERS.test(rawOrigin)
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== rawOrigin
  ) {
    return false;
  }
  if (policy.configuredOrigins.has(parsed.origin)) return true;
  if (policy.deployment) {
    return (
      parsed.protocol === "https:" &&
      (REVIEWED_PRODUCTION_ORIGINS.has(parsed.origin) ||
        REVIEWED_PAGES_HOST.test(parsed.hostname.toLowerCase()))
    );
  }
  return isLocalDevelopmentOrigin(parsed);
}

function normalizedPeerAddress(address: string | null): string | null {
  const candidate = address?.trim() ?? "";
  if (!candidate) return null;
  if (candidate.startsWith("::ffff:")) {
    const ipv4 = candidate.slice("::ffff:".length);
    if (isIP(ipv4) === 4) return ipv4;
  }
  const zoneIndex = candidate.indexOf("%");
  const withoutZone =
    zoneIndex === -1 ? candidate : candidate.slice(0, zoneIndex);
  return isIP(withoutZone) === 0 ? null : withoutZone;
}

function isTrustedPeer(
  peerAddress: string | null,
  policy: TrustedProxyPolicy,
): boolean {
  if (policy.mode === "all") return true;
  if (policy.mode === "none" || peerAddress == null) return false;
  const version = isIP(peerAddress);
  return policy.blockList.check(peerAddress, version === 4 ? "ipv4" : "ipv6");
}

function parseForwardedAddress(
  value: string | null,
  allowList: boolean,
): string | null {
  if (
    value == null ||
    value.length === 0 ||
    value.length > MAX_FORWARDED_HEADER_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }
  const entries = allowList
    ? value.split(",").map((entry) => entry.trim())
    : [value.trim()];
  if (entries.some((entry) => isIP(entry) === 0)) return null;
  return entries[0] ?? null;
}

export function resolveClientIdentity(input: {
  headers: Headers;
  peerAddress: string | null;
  trustedProxy: TrustedProxyPolicy;
}): string {
  const peerAddress = normalizedPeerAddress(input.peerAddress);
  if (!isTrustedPeer(peerAddress, input.trustedProxy)) {
    return peerAddress ?? "unknown";
  }
  for (const [name, allowList] of [
    ["cf-connecting-ip", false],
    ["true-client-ip", false],
    ["x-real-ip", false],
    ["x-forwarded-for", true],
  ] as const) {
    const forwarded = parseForwardedAddress(input.headers.get(name), allowList);
    if (forwarded) return forwarded;
  }
  return peerAddress ?? "unknown";
}

export function hasExactSecretHeader(
  rawHeader: string | null,
  expectedSecret: string,
  domain: string,
): boolean {
  if (
    !expectedSecret ||
    rawHeader == null ||
    rawHeader.length === 0 ||
    rawHeader.length > 1_024 ||
    rawHeader.trim() !== rawHeader ||
    rawHeader.includes(",") ||
    CONTROL_CHARACTERS.test(rawHeader)
  ) {
    return false;
  }
  const digest = (value: string) =>
    createHash("sha256").update(domain).update("\0").update(value).digest();
  return timingSafeEqual(digest(rawHeader), digest(expectedSecret));
}
