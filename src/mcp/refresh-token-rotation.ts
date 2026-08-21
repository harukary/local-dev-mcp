import { randomUUID } from "node:crypto";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { TokenStore } from "./token-store.js";
import { resolveRefreshScopes } from "./oauth-scopes.js";

export const REFRESH_TOKEN_REPLAY_WINDOW_MS = 30_000;

interface RefreshReplay {
  accessTokenId: string;
  clientId: string;
  replacementRefreshToken: string;
  scopes: string[];
  tokens: OAuthTokens;
  expiresAtMs: number;
}

interface RefreshTokenRotatorOptions {
  replayWindowMs?: number;
  now?: () => number;
  issueToken?: () => string;
}

export class RefreshTokenRotator {
  private readonly replays = new Map<string, RefreshReplay>();
  private readonly replayWindowMs: number;
  private readonly now: () => number;
  private readonly issueToken: () => string;

  constructor(
    private readonly tokenStore: TokenStore,
    options: RefreshTokenRotatorOptions = {}
  ) {
    this.replayWindowMs = options.replayWindowMs ?? REFRESH_TOKEN_REPLAY_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.issueToken = options.issueToken ?? randomUUID;
  }

  exchange(
    clientId: string,
    refreshToken: string,
    requestedScopes: string[] | undefined,
    expiresIn: number
  ): OAuthTokens {
    this.cleanupExpiredReplays();

    const replay = this.replays.get(refreshToken);
    if (replay) {
      const replacementTarget = this.tokenStore.getRefreshToken(replay.replacementRefreshToken);
      if (replay.clientId !== clientId || replacementTarget !== replay.accessTokenId) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      resolveRefreshScopes(replay.scopes, requestedScopes);
      return replay.tokens;
    }

    const accessTokenId = this.tokenStore.getRefreshToken(refreshToken);
    if (!accessTokenId) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    const existing = this.tokenStore.getAccessToken(accessTokenId);
    if (!existing) {
      this.tokenStore.deleteRefreshToken(refreshToken);
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (existing.clientId !== clientId) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    const scopes = resolveRefreshScopes(existing.scopes, requestedScopes);
    const newRefreshToken = this.issueToken();
    const expiresAt = Math.floor(this.now() / 1000) + expiresIn;
    const tokens: OAuthTokens = {
      access_token: accessTokenId,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: scopes.join(" "),
    };

    this.tokenStore.deleteRefreshToken(refreshToken);
    this.tokenStore.setRefreshToken(newRefreshToken, accessTokenId);
    this.tokenStore.setAccessToken(accessTokenId, { ...existing, scopes, expiresAt });
    this.replays.set(refreshToken, {
      accessTokenId,
      clientId,
      replacementRefreshToken: newRefreshToken,
      scopes,
      tokens,
      expiresAtMs: this.now() + this.replayWindowMs,
    });

    return tokens;
  }

  revoke(clientId: string, token: string): void {
    this.cleanupExpiredReplays();

    const activeRefreshTarget = this.tokenStore.getRefreshToken(token);
    if (activeRefreshTarget) {
      const accessToken = this.tokenStore.getAccessToken(activeRefreshTarget);
      if (accessToken?.clientId !== clientId) return;
      this.tokenStore.deleteRefreshToken(token);
      this.deleteReplaysForRefreshToken(token);
      return;
    }

    const replay = this.replays.get(token);
    if (replay) {
      if (replay.clientId !== clientId) return;
      this.tokenStore.deleteRefreshToken(replay.replacementRefreshToken);
      this.deleteReplaysForRefreshToken(replay.replacementRefreshToken);
      this.replays.delete(token);
      return;
    }

    const accessToken = this.tokenStore.getAccessToken(token);
    if (accessToken?.clientId !== clientId) return;
    this.tokenStore.deleteRefreshTokensByAccessToken(token);
    this.deleteReplaysForAccessToken(token);
    this.tokenStore.deleteAccessToken(token);
  }

  private cleanupExpiredReplays(): void {
    const now = this.now();
    for (const [token, replay] of this.replays) {
      if (replay.expiresAtMs <= now) this.replays.delete(token);
    }
  }

  private deleteReplaysForRefreshToken(refreshToken: string): void {
    for (const [token, replay] of this.replays) {
      if (replay.replacementRefreshToken === refreshToken) this.replays.delete(token);
    }
  }

  private deleteReplaysForAccessToken(accessTokenId: string): void {
    for (const [token, replay] of this.replays) {
      if (replay.accessTokenId === accessTokenId) this.replays.delete(token);
    }
  }
}
