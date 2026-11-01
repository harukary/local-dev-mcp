import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { createClaudeContext, hashClaudeOwner, resolveClaudeContext } from "../../src/mcp/claude-context.js";

describe("Claude work context persistence", () => {
  it("persists only hashed handle and verified owner, and remains valid after loading", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-context-store-"));
    try {
      const file = join(root, "contexts.json");
      const owner = hashClaudeOwner("owner-identity");
      const store = new ChatContextStore(file);
      const { context_id, chatContextId } = createClaudeContext(store, owner);
      store.setCurrentProject(chatContextId, "alpha");
      store.setWorkingDirectory(chatContextId, "worktree");
      await store.save();

      const saved = readFileSync(file, "utf8");
      expect(saved).not.toContain(context_id);
      expect(saved).not.toContain("owner-identity");
      expect(saved).toContain(owner);
      expect(saved).toContain(chatContextId);
      expect(chatContextId).toMatch(/^claude-context:[0-9a-f]{64}$/);

      const restored = new ChatContextStore(file);
      await restored.load();
      expect(resolveClaudeContext(restored, owner, context_id)).toBe(chatContextId);
      expect(restored.getCurrentProject(chatContextId)).toBe("alpha");
      expect(restored.getWorkingDirectory(chatContextId)).toBe("worktree");
      expect(resolveClaudeContext(restored, hashClaudeOwner("other-identity"), context_id)).toBeUndefined();
      expect(resolveClaudeContext(restored, owner, "ctx_" + "x".repeat(43))).toBeUndefined();
      expect(resolveClaudeContext(restored, owner, "default")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
