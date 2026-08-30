import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserOperationCoordinator } from "./browser-operation-coordinator.js";

export class ActiveTabStore {
  constructor(
    private readonly root: string,
    private readonly coordinator = new BrowserOperationCoordinator(join(root, "tab-locks")),
  ) {}

  async read(profileKey: string): Promise<string | undefined> {
    return await this.transaction(profileKey, ({ read }) => read());
  }

  async write(profileKey: string, targetId: string): Promise<void> {
    await this.transaction(profileKey, ({ write }) => write(targetId));
  }

  async clear(profileKey: string, expectedTargetId?: string): Promise<boolean> {
    return await this.transaction(profileKey, async ({ read, clear }) => {
      if (expectedTargetId !== undefined && await read() !== expectedTargetId) return false;
      await clear();
      return true;
    });
  }

  async transaction<T>(
    profileKey: string,
    operation: (state: {
      read: () => Promise<string | undefined>;
      write: (targetId: string) => Promise<void>;
      clear: () => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return await this.coordinator.run(profileKey, () => operation({
      read: () => this.readUnlocked(profileKey),
      write: (targetId) => this.writeUnlocked(profileKey, targetId),
      clear: () => rm(this.path(profileKey), { force: true }),
    }));
  }

  private async writeUnlocked(profileKey: string, targetId: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(profileKey);
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify({ targetId })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }

  private async readUnlocked(profileKey: string): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(profileKey), "utf8")) as { targetId?: unknown };
      return typeof value.targetId === "string" && value.targetId ? value.targetId : undefined;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  private path(profileKey: string): string {
    return join(this.root, `${profileKey}.json`);
  }

}
