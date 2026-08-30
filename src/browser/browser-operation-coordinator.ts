import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";

const LOCK_PROTOCOL = "LOCAL_DEV_MCP_BROWSER_LOCK_V1 ";

export class BrowserOperationCoordinator {
  private accepting = true;
  private activeCount = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly heldProfiles = new AsyncLocalStorage<Set<string>>();

  constructor(private readonly root: string) {}

  async run<T>(profileKey: string, operation: () => Promise<T>, allowDuringDrain = false): Promise<T> {
    if (this.heldProfiles.getStore()?.has(profileKey)) return await operation();
    if (!this.accepting && !allowDuringDrain) throw new Error("Browser operations are unavailable while the server is shutting down.");
    this.activeCount += 1;
    try {
      const lock = await this.acquireNetworkLock(profileKey);
      try {
        const held = new Set(this.heldProfiles.getStore() ?? []);
        held.add(profileKey);
        return await this.heldProfiles.run(held, operation);
      } finally {
        await new Promise<void>((resolve) => lock.close(() => resolve()));
      }
    } finally {
      this.activeCount -= 1;
      if (this.activeCount === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  async beginDrain(): Promise<void> {
    this.accepting = false;
    if (this.activeCount === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async acquireNetworkLock(profileKey: string): Promise<Server> {
    const identity = createHash("sha256").update(`${this.root}\0${profileKey}`).digest("hex");
    const ports = browserOperationLockPorts(identity);
    const deadline = Date.now() + 60_000;
    while (true) {
      const existingIdentities = await Promise.all(ports.map((port) => readLockIdentity(port)));
      if (existingIdentities.includes(identity)) {
        if (Date.now() >= deadline) throw new Error("Browser profile operation is busy.");
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      let racedWithSameProfile = false;
      for (const port of ports) {
        const lock = await tryAcquirePort(port, identity);
        if (lock) return lock;
        if (await readLockIdentity(port) === identity) {
          racedWithSameProfile = true;
          break;
        }
      }
      if (!racedWithSameProfile) throw new Error("No browser profile operation lock port is available.");
      if (Date.now() >= deadline) throw new Error("Browser profile operation is busy.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function browserOperationLockPorts(identity: string): number[] {
  const ports: number[] = [];
  for (let index = 0; ports.length < 8; index += 1) {
    const digest = createHash("sha256").update(`${identity}\0${index}`).digest();
    const port = 20_000 + digest.readUInt32BE(0) % 20_000;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function tryAcquirePort(port: number, identity: string): Promise<Server | undefined> {
  const lock = createServer((socket) => {
    socket.setTimeout(500, () => socket.destroy());
    socket.once("data", () => socket.end(`${LOCK_PROTOCOL}${identity}\n`));
  });
  return await new Promise<Server | undefined>((resolve, reject) => {
    lock.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(error);
    });
    lock.once("listening", () => resolve(lock));
    lock.listen(port, "127.0.0.1");
  });
}

async function readLockIdentity(port: number): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let data = "";
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250, () => finish());
    socket.once("error", () => finish());
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > LOCK_PROTOCOL.length + 65) return finish();
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const line = data.slice(0, newline);
      finish(line.startsWith(LOCK_PROTOCOL) ? line.slice(LOCK_PROTOCOL.length) : undefined);
    });
    socket.once("connect", () => socket.write(`${LOCK_PROTOCOL}?\n`));
  });
}
