import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

interface TokenData {
  accessTokens: Record<string, AuthInfo>;
  refreshTokens: Record<string, string>;
  clients: Record<string, OAuthClientInformationFull>;
}

const DEFAULT_PATH = join(process.cwd(), ".local-dev-mcp", "tokens.json");

export class TokenStore {
  private accessTokens = new Map<string, AuthInfo>();
  private refreshTokens = new Map<string, string>();
  private clients = new Map<string, OAuthClientInformationFull>();
  private filePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath || DEFAULT_PATH;
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data: TokenData = JSON.parse(raw);

      const now = Math.floor(Date.now() / 1000);
      const refreshTokenTargets = new Set(Object.values(data.refreshTokens ?? {}));

      for (const [k, v] of Object.entries(data.accessTokens)) {
        if (!v.expiresAt || v.expiresAt > now || refreshTokenTargets.has(k)) {
          this.accessTokens.set(k, v);
        }
      }
      for (const [k, v] of Object.entries(data.refreshTokens)) {
        this.refreshTokens.set(k, v);
      }
      for (const [k, v] of Object.entries(data.clients)) {
        this.clients.set(k, v);
      }
    } catch {
      // corrupt file, start fresh
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 500);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const data: TokenData = {
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens),
      clients: Object.fromEntries(this.clients),
    };
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await chmod(dir, 0o700);
    await writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }

  // Access tokens
  getAccessToken(token: string): AuthInfo | undefined {
    return this.accessTokens.get(token);
  }

  setAccessToken(token: string, info: AuthInfo): void {
    this.accessTokens.set(token, info);
    this.scheduleFlush();
  }

  deleteAccessToken(token: string): void {
    this.accessTokens.delete(token);
    this.scheduleFlush();
  }

  // Refresh tokens
  getRefreshToken(token: string): string | undefined {
    return this.refreshTokens.get(token);
  }

  setRefreshToken(token: string, accessTokenId: string): void {
    this.refreshTokens.set(token, accessTokenId);
    this.scheduleFlush();
  }

  deleteRefreshToken(token: string): void {
    this.refreshTokens.delete(token);
    this.scheduleFlush();
  }

  findRefreshTokenByAccessToken(accessTokenId: string): string | undefined {
    for (const [rt, at] of this.refreshTokens) {
      if (at === accessTokenId) return rt;
    }
    return undefined;
  }

  // Clients
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  getAllClients(): OAuthClientInformationFull[] {
    return Array.from(this.clients.values());
  }

  async registerClient(clientInfo: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.clients.set(clientInfo.client_id, clientInfo);
    this.scheduleFlush();
    return clientInfo;
  }

  setClient(clientId: string, client: OAuthClientInformationFull): void {
    this.clients.set(clientId, client);
    this.scheduleFlush();
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
