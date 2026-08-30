import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveTabStore } from "../../src/browser/active-tab-store.js";
import { BrowserOperationCoordinator } from "../../src/browser/browser-operation-coordinator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ActiveTabStore", () => {
  it("only clears the target selection it observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "active-tabs-"));
    roots.push(root);
    const store = new ActiveTabStore(join(root, "state"));
    await store.write("profile", "target-a");
    await store.write("profile", "target-b");

    await expect(store.clear("profile", "target-a")).resolves.toBe(false);
    await expect(store.read("profile")).resolves.toBe("target-b");
    await expect(store.clear("profile", "target-b")).resolves.toBe(true);
    await expect(store.read("profile")).resolves.toBeUndefined();
  });

  it("reuses the outer browser operation lock without reacquiring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "active-tabs-nested-"));
    roots.push(root);
    const coordinator = new BrowserOperationCoordinator(join(root, "operations"));
    const store = new ActiveTabStore(join(root, "state"), coordinator);

    await expect(coordinator.run("profile", async () => {
      await store.write("profile", "target-a");
      return await store.read("profile");
    })).resolves.toBe("target-a");
  });
});
