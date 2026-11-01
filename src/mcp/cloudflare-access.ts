import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV = "LOCAL_DEV_MCP_CLOUDFLARE_TEAM_DOMAIN";
export const CLOUDFLARE_ACCESS_AUDIENCE_ENV = "LOCAL_DEV_MCP_CLOUDFLARE_AUDIENCE";

export interface CloudflareAccessConfig {
  issuer: string;
  audience: string;
}

export function resolveCloudflareAccessConfig(
  env: NodeJS.ProcessEnv = process.env
): CloudflareAccessConfig | undefined {
  const teamDomain = env[CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV]?.trim();
  const audience = env[CLOUDFLARE_ACCESS_AUDIENCE_ENV]?.trim();
  if (!teamDomain && !audience) return undefined;
  if (!teamDomain || !audience) {
    throw new Error(`Both ${CLOUDFLARE_ACCESS_TEAM_DOMAIN_ENV} and ${CLOUDFLARE_ACCESS_AUDIENCE_ENV} must be set.`);
  }

  let issuer: URL;
  try {
    issuer = new URL(teamDomain.startsWith("https://") ? teamDomain : `https://${teamDomain}`);
  } catch {
    throw new Error("Cloudflare Access team domain is invalid.");
  }
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".cloudflareaccess.com") ||
    issuer.username || issuer.password || issuer.port ||
    issuer.pathname !== "/" || issuer.search || issuer.hash
  ) {
    throw new Error("Cloudflare Access team domain must be a HTTPS cloudflareaccess.com origin.");
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(audience)) {
    throw new Error("Cloudflare Access application audience is invalid.");
  }
  return { issuer: issuer.origin, audience };
}

export function createCloudflareAccessVerifier(
  config: CloudflareAccessConfig,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`))
): (jwt: string) => Promise<void> {
  return async (jwt) => {
    if (!jwt || jwt.length > 16384) throw new Error("Cloudflare Access JWT is missing or too large.");
    await jwtVerify(jwt, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
    });
  };
}
