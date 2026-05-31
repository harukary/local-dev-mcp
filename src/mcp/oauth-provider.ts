import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { TokenStore } from "./token-store.js";

const authCodes = new Map<string, { challenge: string; clientId: string }>();

function issueToken(): string {
  return randomUUID();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export const LOCAL_DEV_MCP_CLIENT_ID_ENV = "LOCAL_DEV_MCP_CLIENT_ID";
export const LOCAL_DEV_MCP_CLIENT_SECRET_ENV = "LOCAL_DEV_MCP_CLIENT_SECRET";
export const LOCAL_DEV_MCP_PASSPHRASE_ENV = "LOCAL_DEV_MCP_PASSPHRASE";
export const LOCAL_DEV_MCP_ACCESS_TOKEN_TTL_SECONDS_ENV = "LOCAL_DEV_MCP_ACCESS_TOKEN_TTL_SECONDS";
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const AUTH_PASSPHRASE: string =
  process.env[LOCAL_DEV_MCP_PASSPHRASE_ENV] || randomUUID();

export const tokenStore = new TokenStore();

export function getAccessTokenTtlSeconds(): number {
  const raw = process.env[LOCAL_DEV_MCP_ACCESS_TOKEN_TTL_SECONDS_ENV]?.trim();
  if (!raw) return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 60) {
    return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  }
  return parsed;
}

async function seedClient(): Promise<void> {
  await tokenStore.load();

  const envId = process.env[LOCAL_DEV_MCP_CLIENT_ID_ENV];
  const envSecret = process.env[LOCAL_DEV_MCP_CLIENT_SECRET_ENV];

  // Restore existing client: by env ID, or first stored client
  const existing = envId
    ? tokenStore.getClient(envId)
    : tokenStore.getAllClients()[0];

  if (existing) {
    console.error(`[OAuth] client_id: ${existing.client_id} (restored from store)`);
    return;
  }

  // No existing client — create new
  const clientId = envId || `mcp-${randomUUID().slice(0, 12)}`;
  const clientSecret = envSecret || randomUUID();

  if (!envId) {
    console.error(`[OAuth] No LOCAL_DEV_MCP_CLIENT_ID set — generated temporary client_id.`);
  }
  console.error(`[OAuth] client_id: ${clientId}`);
  console.error(`[OAuth] client_secret: [set via env or generated]`);

  const full: OAuthClientInformationFull = {
    redirect_uris: ["http://localhost/redirect"],
    token_endpoint_auth_method: "none",
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: nowSeconds(),
  };
  tokenStore.setClient(clientId, full);
}

const clientsStore: OAuthRegisteredClientsStore = tokenStore;

export const personalOAuthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const code = issueToken();
    authCodes.set(code, {
      challenge: params.codeChallenge,
      clientId: client.client_id,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }
    res.redirect(302, redirectUrl.toString());
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const stored = authCodes.get(authorizationCode);
    if (!stored) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return stored.challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const stored = authCodes.get(authorizationCode);
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    authCodes.delete(authorizationCode);

    const accessToken = issueToken();
    const refreshToken = issueToken();
    const expiresIn = getAccessTokenTtlSeconds();
    const expiresAt = nowSeconds() + expiresIn;

    tokenStore.setAccessToken(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: ["all"],
      expiresAt,
    });
    tokenStore.setRefreshToken(refreshToken, accessToken);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: "all",
    };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    const accessTokenId = tokenStore.getRefreshToken(refreshToken);
    if (!accessTokenId) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    const existing = tokenStore.getAccessToken(accessTokenId);
    if (!existing || existing.clientId !== client.client_id) {
      tokenStore.deleteRefreshToken(refreshToken);
      throw new InvalidGrantError("Invalid refresh token");
    }

    tokenStore.deleteRefreshToken(refreshToken);
    const newRefreshToken = issueToken();
    tokenStore.setRefreshToken(newRefreshToken, accessTokenId);

    const expiresIn = getAccessTokenTtlSeconds();
    const expiresAt = nowSeconds() + expiresIn;
    tokenStore.setAccessToken(accessTokenId, { ...existing, expiresAt });

    return {
      access_token: accessTokenId,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: "all",
    };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = tokenStore.getAccessToken(token);
    if (!info) {
      throw new InvalidTokenError("Token not found");
    }
    if (info.expiresAt && info.expiresAt < nowSeconds()) {
      if (!tokenStore.findRefreshTokenByAccessToken(token)) {
        tokenStore.deleteAccessToken(token);
      }
      throw new InvalidTokenError("Token has expired");
    }
    return info;
  },

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    tokenStore.deleteAccessToken(request.token);
    const rt = tokenStore.findRefreshTokenByAccessToken(request.token);
    if (rt) tokenStore.deleteRefreshToken(rt);
  },
};

// Initialize store and seed client on import
await seedClient();
