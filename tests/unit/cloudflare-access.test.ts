import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  CLOUDFLARE_ACCESS_AUDIENCE_ENV,
  CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV,
  createCloudflareAccessVerifier,
  resolveCloudflareAccessConfig,
} from "../../src/mcp/cloudflare-access.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "a".repeat(64);

describe("Cloudflare Access configuration", () => {
  it("is opt-in and requires both fields", () => {
    expect(resolveCloudflareAccessConfig({})).toBeUndefined();
    expect(() => resolveCloudflareAccessConfig({
      [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: ISSUER,
    })).toThrow("Both");
    expect(() => resolveCloudflareAccessConfig({
      [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: AUDIENCE,
    })).toThrow("Both");
    expect(resolveCloudflareAccessConfig({
      [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: "example.cloudflareaccess.com",
      [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: AUDIENCE,
    })).toEqual({ issuer: ISSUER, audience: AUDIENCE });
  });

  it("rejects non-Cloudflare origins and malformed audiences", () => {
    const env = {
      [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: ISSUER,
      [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: AUDIENCE,
    };
    for (const teamDomain of [
      "http://example.cloudflareaccess.com",
      "https://example.cloudflareaccess.com.attacker.test",
      "https://example.cloudflareaccess.com/path",
      "https://other.test",
    ]) {
      expect(() => resolveCloudflareAccessConfig({
        ...env,
        [CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]: teamDomain,
      })).toThrow();
    }
    expect(() => resolveCloudflareAccessConfig({
      ...env,
      [CLOUDFLARE_ACCESS_AUDIENCE_ENV]: "not-valid",
    })).toThrow("audience");
  });
});

describe("Cloudflare Access JWT verification", () => {
  it("verifies signature, audience, issuer and expiration", async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
    const verify = createCloudflareAccessVerifier(
      { issuer: ISSUER, audience: AUDIENCE },
      createLocalJWKSet({ keys: [jwk] })
    );
    const sign = (issuer: string, audience: string, expiration: string) => new SignJWT({ sub: "owner" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(pair.privateKey);

    const valid = await sign(ISSUER, AUDIENCE, "15m");
    await expect(verify(valid)).resolves.toEqual({ subject: "owner" });
    const withoutSubject = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("15m").sign(pair.privateKey);
    await expect(verify(withoutSubject)).rejects.toThrow("subject");
    await expect(verify(await sign(ISSUER, "other-app", "15m"))).rejects.toThrow();
    await expect(verify(await sign("https://other.cloudflareaccess.com", AUDIENCE, "15m"))).rejects.toThrow();
    await expect(verify(await sign(ISSUER, AUDIENCE, "-15m"))).rejects.toThrow();
    await expect(verify(valid.slice(0, -2) + "xx")).rejects.toThrow();
    await expect(verify("x".repeat(16385))).rejects.toThrow();
    await expect(verify("")).rejects.toThrow();
  });
});
