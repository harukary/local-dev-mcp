import { appendFile, rename, rm, stat } from "node:fs/promises";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditLogEntry } from "../types.js";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_BACKUPS = 3;

export class AuditLogger {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly backups: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(logPath: string, options: { max_bytes?: number; backups?: number } = {}) {
    this.logPath = logPath;
    this.maxBytes = Math.max(1024, options.max_bytes ?? DEFAULT_MAX_BYTES);
    this.backups = Math.min(10, Math.max(0, Math.round(options.backups ?? DEFAULT_BACKUPS)));
    const dir = dirname(logPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error("Audit log directory must be a real directory.");
    chmodSync(dir, 0o700);
    // Restrict existing logs and rotated archives before any new writes.
    for (let index = 0; index <= this.backups; index++) {
      const path = index === 0 ? logPath : `${logPath}.${index}`;
      try {
        if (!lstatSync(path).isFile()) throw new Error("Audit log must be a regular file.");
        chmodSync(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const operation = this.pending
      .catch(() => undefined)
      .then(async () => {
        await this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
        await appendFile(this.logPath, line, { encoding: "utf8", mode: 0o600 });
      });
    this.pending = operation;
    return await operation;
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      currentBytes = (await stat(this.logPath)).size;
    } catch {
      return;
    }
    if (currentBytes + incomingBytes <= this.maxBytes) return;

    if (this.backups === 0) {
      await rm(this.logPath, { force: true });
      return;
    }

    for (let index = this.backups - 1; index >= 1; index -= 1) {
      await rename(`${this.logPath}.${index}`, `${this.logPath}.${index + 1}`).catch(() => undefined);
    }
    await rename(this.logPath, `${this.logPath}.1`).catch(() => undefined);
  }
}
