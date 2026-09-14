import type { AppContext } from "../../server.js";
import { jsonError, jsonResult } from "./common.js";
import { handleWorkspaceRead } from "./workspace-read.js";
import { handleWorkspaceSearch } from "./workspace-search.js";
import { handleWorkspaceList } from "./workspace-list.js";
import { validateToolInput } from "../../input-validation.js";
import { ChatContextStore } from "../../../project/context-store.js";

export type ReadBatchItem = { tool: "workspace.read" | "workspace.search" | "workspace.list"; arguments: Record<string, unknown> };

function compactBatchValue(tool: ReadBatchItem["tool"], value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || "error" in value) return value;
  const record = value as Record<string, unknown>;
  if (tool === "workspace.read") {
    const { project_id: _projectId, absolute_path: _absolutePath, size_bytes: _sizeBytes, sha256: _sha256, ...compact } = record;
    return compact;
  }
  if (tool === "workspace.search") {
    const { project_id: _projectId, query: _query, max_results: _maxResults, offset: _offset, line_preview_max_bytes: _linePreview, context_preview_max_bytes: _contextPreview, ...compact } = record;
    return compact;
  }
  const { project_id: _projectId, max_entries: _maxEntries, ...compact } = record;
  return compact;
}

export async function handleWorkspaceBatch(ctx: AppContext, chat: string, args: { requests?: ReadBatchItem[]; max_bytes?: number; detail?: "compact" | "full" }) {
  if (!Array.isArray(args.requests) || !args.requests.length || args.requests.length > 20) return jsonError("INVALID_BATCH", "Provide 1 to 20 read-only requests.");
  if (args.requests.some(item => !item || !["workspace.read", "workspace.search", "workspace.list"].includes(item.tool) || !item.arguments || typeof item.arguments !== "object")) return jsonError("INVALID_BATCH", "Only workspace read, search and list are supported.");
  const contextStore = new ChatContextStore();
  Object.assign(contextStore.getOrCreate(chat), ctx.contextStore.get(chat));
  const capturedContext = { ...ctx, contextStore };
  const results: unknown[] = [];
  let remaining = Math.min(256 * 1024, Math.max(1024, args.max_bytes ?? 64 * 1024));
  for (let offset = 0; offset < args.requests.length; offset += 4) {
    const group = await Promise.allSettled(args.requests.slice(offset, offset + 4).map(async item => {
      const invalid = validateToolInput(item.tool, item.arguments);
      if (invalid) return jsonError("INVALID_ARGUMENT", invalid);
      const options = { ...item.arguments, max_bytes: Math.min(Number(item.arguments.max_bytes) || 16 * 1024, 32 * 1024), max_results: Math.min(Number(item.arguments.max_results) || 20, 50), max_entries: Math.min(Number(item.arguments.max_entries) || 100, 200) };
      if (item.tool === "workspace.read") return await handleWorkspaceRead(capturedContext, chat, options);
      if (item.tool === "workspace.search") return await handleWorkspaceSearch(capturedContext, chat, options);
      return await handleWorkspaceList(capturedContext, chat, options);
    }));
    for (const [index, settled] of group.entries()) {
      const result = settled.status === "fulfilled" ? settled.value : jsonError("BATCH_ITEM_FAILED", settled.reason instanceof Error ? settled.reason.message : String(settled.reason));
      const fullValue = result.structuredContent ?? JSON.parse(result.content[0].text);
      const value = args.detail === "full" ? fullValue : compactBatchValue(args.requests[offset + index].tool, fullValue);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      results.push({ index: offset + index, tool: args.requests[offset + index].tool, result: bytes <= remaining ? value : { error: { code: "BATCH_OUTPUT_LIMIT", message: "Read this item separately with a smaller range or output budget." } } });
      if (bytes <= remaining) remaining -= bytes;
    }
  }
  return jsonResult({ results });
}
