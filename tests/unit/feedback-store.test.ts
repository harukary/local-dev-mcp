import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeedbackStore } from "../../src/feedback/store.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-dev-feedback-"));
  roots.push(root);
  const path = join(root, "runtime", "feedback.json");
  const store = await FeedbackStore.open(path);
  return { path, store };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const report = {
  kind: "bug" as const,
  title: "batch output limitation",
  description: "Large result batches unexpectedly truncate valid responses",
  related_tool: "workspace.batch",
  project_id: "local-dev-mcp",
  source: "chatgpt" as const,
};

describe("FeedbackStore", () => {
  it("deduplicates exact titles, counts cross-client reports, persists and reopens", async () => {
    const { path, store } = await fixture();
    const first = await store.report(report);
    expect(first).toMatchObject({ created: true, reopened: false, item: { occurrences: 1, sources: ["chatgpt"], status: "open" } });
    const again = await store.report({ ...report, source: "claude", title: "  BATCH   output limitation " });
    expect(again).toMatchObject({
      created: false, reopened: false,
      item: { id: first.item.id, occurrences: 2, sources: ["chatgpt", "claude"] },
    });
    await expect(store.update({ id: first.item.id, status: "resolved" })).rejects.toThrow("FEEDBACK_RESOLUTION_REQUIRED");
    await store.update({ id: first.item.id, status: "in_progress", note: "Root cause confirmed." });
    await store.update({ id: first.item.id, status: "resolved", resolution: "Validated batch handling in unit and MCP tests." });
    expect((await store.list()).total).toBe(0);
    expect((await store.list({ status: "resolved" })).total).toBe(1);
    const persisted = await FeedbackStore.open(path);
    const repeat = await persisted.report({
      ...report, title: "Issue with different wording", source: "muse", existing_id: first.item.id,
      project_id: undefined,
    });
    expect(repeat).toMatchObject({
      created: false, reopened: true,
      item: { id: first.item.id, status: "open", occurrences: 3, reopened: 1, sources: ["chatgpt", "claude", "muse"] },
    });
    expect((await persisted.list({ status: "active" })).total).toBe(1);
    expect((await persisted.list({ project_id: "local-dev-mcp" })).total).toBe(1);
    await expect(persisted.update({ id: first.item.id, status: "resolved" })).rejects.toThrow("FEEDBACK_RESOLUTION_REQUIRED");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });

  it("serializes concurrent writes and filters/paginates reports", async () => {
    const { path, store } = await fixture();
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.report({
      ...report, title: `Issue ${index}`, source: index % 2 ? "claude" : "chatgpt",
    })));
    const two = await store.list({ limit: 2 });
    expect(two).toMatchObject({ total: 12, has_more: true, next_offset: 2 });
    expect((await store.list({ limit: 100, offset: 2 })).items).toHaveLength(10);
    expect((await store.list({ status: "all", kind: "missing_feature" })).total).toBe(0);
    expect((await store.list({ project_id: "another-project" })).total).toBe(0);
    await expect((await FeedbackStore.open(path)).list({ limit: 100 })).resolves.toMatchObject({ total: 12 });
  });

  it("redacts common secrets in saved summaries and never overwrites malformed data", async () => {
    const { path, store } = await fixture();
    await store.report({
      ...report,
      description: "Bearer Authorization: Bearer token_value Cookie: session=keep?token=secretvalue github ghp_abcdefghijklmnopqrstuvwxyz123456789012",
      suggestion: "See https://example.com/?api_key=private123",
    });
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain("token_value");
    expect(contents).not.toContain("secretvalue");
    expect(contents).not.toContain("private123");
    await writeFile(path, '{"version":2,"items":[]}', "utf8");
    await expect(FeedbackStore.open(path)).rejects.toThrow("Invalid feedback store");
    expect(await readFile(path, "utf8")).toBe('{"version":2,"items":[]}');
  });

  it("rejects explicit recurrence of a different issue kind or project", async () => {
    const { store } = await fixture();
    const { item } = await store.report(report);
    await expect(store.report({ ...report, kind: "improvement", existing_id: item.id })).rejects.toThrow("FEEDBACK_MISMATCH");
    await expect(store.report({ ...report, project_id: "other", existing_id: item.id })).rejects.toThrow("FEEDBACK_MISMATCH");
  });
});
