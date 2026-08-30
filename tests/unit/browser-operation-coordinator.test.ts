import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserOperationCoordinator, browserOperationLockPorts } from "../../src/browser/browser-operation-coordinator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BrowserOperationCoordinator", () => {
  it("serializes the same profile across coordinator instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-operations-"));
    roots.push(root);
    const first = new BrowserOperationCoordinator(root);
    const second = new BrowserOperationCoordinator(root);
    const events: string[] = [];
    let release!: () => void;
    const held = first.run("profile", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => { release = resolve; });
      events.push("first-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = second.run("profile", async () => { events.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([held, queued]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("waits for active work and rejects new work after drain begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-operations-drain-"));
    roots.push(root);
    const coordinator = new BrowserOperationCoordinator(root);
    let release!: () => void;
    const active = coordinator.run("profile", () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    let drained = false;
    const drain = coordinator.beginDrain().then(() => { drained = true; });
    await expect(coordinator.run("other", async () => undefined)).rejects.toThrow(/shutting down/);
    expect(drained).toBe(false);
    release();
    await Promise.all([active, drain]);
    expect(drained).toBe(true);
  });

  it("allows a nested stop operation to reuse its held profile lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-operations-nested-"));
    roots.push(root);
    const coordinator = new BrowserOperationCoordinator(root);
    await expect(coordinator.run("profile", () => coordinator.run("profile", async () => "done", true))).resolves.toBe("done");
  });

  it("skips a candidate port owned by an unrelated local listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-operations-collision-"));
    roots.push(root);
    const identity = createHash("sha256").update(`${root}\0profile`).digest("hex");
    const occupiedPort = browserOperationLockPorts(identity)[0]!;
    const unrelated = createServer((socket) => socket.once("data", () => socket.end("UNRELATED\n")));
    await new Promise<void>((resolve, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(occupiedPort, "127.0.0.1", () => resolve());
    });
    try {
      const coordinator = new BrowserOperationCoordinator(root);
      await expect(coordinator.run("profile", async () => "done")).resolves.toBe("done");
    } finally {
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    }
  });
});
