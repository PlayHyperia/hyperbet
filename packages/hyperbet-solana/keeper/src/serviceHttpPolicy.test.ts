import { describe, expect, test } from "bun:test";

import {
  hasExactSecretHeader,
  isAllowedAppOrigin,
  resolveClientIdentity,
  resolveServiceHttpPolicy,
} from "./serviceHttpPolicy";

describe("Hyperbet service HTTP policy", () => {
  test("accepts only reviewed exact production origins", () => {
    const policy = resolveServiceHttpPolicy({ NODE_ENV: "production" });
    expect(isAllowedAppOrigin("https://hyperbet.win", policy)).toBe(true);
    expect(
      isAllowedAppOrigin("https://preview.hyperbet.pages.dev", policy),
    ).toBe(true);
    expect(isAllowedAppOrigin("https://evilhyperbet.win", policy)).toBe(false);
    expect(isAllowedAppOrigin("https://hyperbet.win.evil.test", policy)).toBe(
      false,
    );
    expect(isAllowedAppOrigin("https://hyperbet.win/", policy)).toBe(false);
    expect(
      isAllowedAppOrigin(
        "https://hyperbet.win, https://attacker.invalid",
        policy,
      ),
    ).toBe(false);
    expect(isAllowedAppOrigin("http://localhost:5173", policy)).toBe(false);
  });

  test("confines loopback and private origins to local development", () => {
    const policy = resolveServiceHttpPolicy({ NODE_ENV: "development" });
    expect(isAllowedAppOrigin("http://localhost:5173", policy)).toBe(true);
    expect(isAllowedAppOrigin("http://192.168.1.9:4173", policy)).toBe(true);
    expect(isAllowedAppOrigin("https://hyperbet.win", policy)).toBe(false);
  });

  test("treats staging as a deployment boundary", () => {
    const policy = resolveServiceHttpPolicy({ NODE_ENV: "staging" });
    expect(policy.deployment).toBe(true);
    expect(isAllowedAppOrigin("https://hyperbet.win", policy)).toBe(true);
    expect(isAllowedAppOrigin("http://localhost:5173", policy)).toBe(false);
    expect(() =>
      resolveServiceHttpPolicy({
        NODE_ENV: "staging",
        DISABLE_RATE_LIMIT: "true",
      }),
    ).toThrow(/cannot be enabled/u);
    expect(() =>
      resolveServiceHttpPolicy({
        NODE_ENV: "staging",
        HYPERBET_TRUST_PROXY: "true",
      }),
    ).toThrow(/forbidden/u);
  });

  test("validates configured origins and production rate-limit authority", () => {
    expect(
      resolveServiceHttpPolicy({
        NODE_ENV: "production",
        CORS_ORIGINS: "https://app.example.com",
      }).configuredOrigins.has("https://app.example.com"),
    ).toBe(true);
    for (const invalid of [
      "http://app.example.com",
      "https://app.example.com/",
      "https://app.example.com/path",
      "https://user@app.example.com",
      "https://app.example.com,https://app.example.com",
      " https://app.example.com",
      "https://app.example.com, https://preview.example.com",
    ]) {
      expect(() =>
        resolveServiceHttpPolicy({
          NODE_ENV: "production",
          CORS_ORIGINS: invalid,
        }),
      ).toThrow();
    }
    expect(() =>
      resolveServiceHttpPolicy({
        NODE_ENV: "production",
        DISABLE_RATE_LIMIT: "true",
      }),
    ).toThrow(/cannot be enabled/u);
  });

  test("trusts forwarding headers only from an explicit peer allowlist", () => {
    const noTrust = resolveServiceHttpPolicy({ NODE_ENV: "production" });
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.3",
    });
    expect(
      resolveClientIdentity({
        headers,
        peerAddress: "10.20.1.5",
        trustedProxy: noTrust.trustedProxy,
      }),
    ).toBe("10.20.1.5");

    const exactTrust = resolveServiceHttpPolicy({
      NODE_ENV: "production",
      HYPERBET_TRUST_PROXY: "10.20.0.0/16,2001:db8::/48",
    });
    expect(
      resolveClientIdentity({
        headers,
        peerAddress: "10.20.1.5",
        trustedProxy: exactTrust.trustedProxy,
      }),
    ).toBe("203.0.113.7");
    expect(() =>
      resolveServiceHttpPolicy({
        NODE_ENV: "production",
        HYPERBET_TRUST_PROXY: "true",
      }),
    ).toThrow(/forbidden/u);
    expect(() =>
      resolveServiceHttpPolicy({
        NODE_ENV: "production",
        HYPERBET_TRUST_PROXY: "10.0.0.0/33",
      }),
    ).toThrow(/invalid CIDR prefix/u);
    expect(
      resolveClientIdentity({
        headers: new Headers({ "x-forwarded-for": "invalid, 203.0.113.7" }),
        peerAddress: "10.20.1.5",
        trustedProxy: exactTrust.trustedProxy,
      }),
    ).toBe("10.20.1.5");
  });

  test("requires one exact bounded secret header", () => {
    expect(hasExactSecretHeader("secret", "secret", "write")).toBe(true);
    expect(hasExactSecretHeader("secret ", "secret", "write")).toBe(false);
    expect(hasExactSecretHeader("secret,secret", "secret", "write")).toBe(
      false,
    );
    expect(hasExactSecretHeader("secret", "", "write")).toBe(false);
  });
});
