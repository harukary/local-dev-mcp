import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditLogEntry } from "../types.js";

export class AuditLogger {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  async log(entry: AuditLogEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.logPath, line, "utf-8");
  }
}
