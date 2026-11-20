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
  if ((ctx.clientProfile === "claude" || ctx.clientProfile === "muse") && args.requests.some(item =>
    Object.hasOwn(item.arguments, "project_id") || Object.hasOwn(item.arguments, "working_dir")
  )) {
    return jsonError("CONTEXT_PROJECT_CONFLICT", "Nested batch project scope cannot override the authenticated work context.");
  }
  const contextStore = new ChatContextStore();
  Object.assign(contextStore.getOrCreate(chat), ctx.contextStore.get(chat));
  const capturedContext = { ...ctx, contextStore };
  const results: unknown[] = [];
  let remaining = Math.min(1024 * 1024, Math.max(1024, args.max_bytes ?? 256 * 1024));
  const runItem = async (item: ReadBatchItem, limits: Record<string, number> = {}) => {
    const invalid = validateToolInput(item.tool, item.arguments);
    if (invalid) return jsonError("INVALID_ARGUMENT", invalid);
    const options = {
      ...item.arguments,
      max_bytes: Math.min(Number(item.arguments.max_bytes) || 32 * 1024, 128 * 1024),
      max_results: Math.min(Number(item.arguments.max_results) || 20, 50),
      max_entries: Math.min(Number(item.arguments.max_entries) || 100, 200),
      ...limits,
    };
    if (item.tool === "workspace.read") return await handleWorkspaceRead(capturedContext, chat, options);
    if (item.tool === "workspace.search") return await handleWorkspaceSearch(capturedContext, chat, options);
    return await handleWorkspaceList(capturedContext, chat, options);
  };
  for (let offset = 0; offset < args.requests.length; offset += 4) {
    const group = await Promise.allSettled(args.requests.slice(offset, offset + 4).map(item => runItem(item)));
    for (const [index, settled] of group.entries()) {
      const position = offset + index;
      const item = args.requests[position];
      let result = settled.status === "fulfilled" ? settled.value : jsonError("BATCH_ITEM_FAILED", settled.reason instanceof Error ? settled.reason.message : String(settled.reason));
      let fullValue = result.structuredContent ?? JSON.parse(result.content[0].text);
      let value = args.detail === "full" ? fullValue : compactBatchValue(item.tool, fullValue);
      let bytes = Buffer.byteLength(JSON.stringify(value));
      const fairShare = Math.floor(remaining / (args.requests.length - position));
      const limits: Record<string, number> = {};
      // Re-run only oversized successful items with a smaller result cap. Preserve
      // each tool's native truncation/continuation metadata instead of dropping it.
      for (let attempt = 0; attempt < 2 && bytes > fairShare && !("isError" in result && result.isError === true); attempt += 1) {
        const ratio = Math.max(0, Math.min(0.9, (fairShare - 768) / bytes));
        const record = value as Record<string, unknown>;
        let field: string;
        let current: number;
        if (item.tool === "workspace.read") {
          field = "max_bytes";
          current = Number(limits.max_bytes ?? record.returned_bytes ?? 32 * 1024);
        } else if (item.tool === "workspace.search") {
          field = "max_results";
          current = Number(limits.max_results ?? (Array.isArray(record.matches) ? record.matches.length : 20));
        } else {
          field = "max_entries";
          current = Number(limits.max_entries ?? (Array.isArray(record.entries) ? record.entries.length : 100));
        }
        const reduced = Math.max(1, Math.floor(current * ratio));
        if (reduced >= current) break;
        limits[field] = reduced;
        result = await runItem(item, limits);
        fullValue = result.structuredContent ?? JSON.parse(result.content[0].text);
        value = args.detail === "full" ? fullValue : compactBatchValue(item.tool, fullValue);
        bytes = Buffer.byteLength(JSON.stringify(value));
      }
      results.push({
        index: position,
        tool: item.tool,
        result: bytes <= remaining ? value : {
          error: {
            code: "BATCH_OUTPUT_LIMIT",
            message: "Read this item separately with a smaller range or a larger shared max_bytes.",
            details: { item_bytes: bytes, remaining_bytes: remaining },
          },
        },
      });
      if (bytes <= remaining) remaining -= bytes;
    }
  }
  return jsonResult({ results });
}
