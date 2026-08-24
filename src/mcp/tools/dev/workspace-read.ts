import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AppContext } from "../../server.js";
import { getActiveProject, isProbablyBinary, jsonError, jsonResult, resolveProjectPath, sha256 } from "./common.js";

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;

async function isBinaryFile(pathname: string): Promise<boolean> {
  const handle = await open(pathname, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return isProbablyBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function handleWorkspaceRead(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; start_line?: number; end_line?: number; max_bytes?: number }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  const resolved = resolveProjectPath(project, args?.path);
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);

  try {
    const fileStat = await stat(resolved.absolutePath);
    if (!fileStat.isFile()) return jsonError("NOT_A_FILE", "Path is not a regular file.");
    if (await isBinaryFile(resolved.absolutePath)) return jsonError("BINARY_FILE", "Binary files are not supported by workspace.read.");

    const maxBytes = Math.max(1, args?.max_bytes ?? DEFAULT_MAX_BYTES);
    const start = Math.max(1, args?.start_line ?? 1);
    const requestedEnd = Math.max(start, args?.end_line ?? Number.MAX_SAFE_INTEGER);

    if (fileStat.size <= MAX_FULL_READ_BYTES) {
      const bytes = await readFile(resolved.absolutePath);
      const content = bytes.toString("utf8");
      const lines = content.split(/\r?\n/);
      const end = Math.min(lines.length, requestedEnd);
      const selected: Array<{ line: number; text: string }> = [];
      let returnedBytes = 0;
      let truncated = false;
      for (let index = start - 1; index < end; index += 1) {
        const text = lines[index] ?? "";
        const size = Buffer.byteLength(text, "utf8") + 1;
        if (selected.length > 0 && returnedBytes + size > maxBytes) { truncated = true; break; }
        selected.push({ line: index + 1, text });
        returnedBytes += size;
      }
      return jsonResult({
        project_id: project.projectId,
        path: resolved.relativePath,
        absolute_path: resolved.absolutePath,
        start_line: start,
        end_line: selected.at(-1)?.line ?? start - 1,
        total_lines: lines.length,
        has_more: truncated || end < lines.length,
        truncated,
        size_bytes: fileStat.size,
        sha256: sha256(content),
        lines: selected,
      });
    }

    const selected: Array<{ line: number; text: string }> = [];
    let lineNumber = 0;
    let returnedBytes = 0;
    let truncated = false;
    let hasMore = false;
    const stream = createReadStream(resolved.absolutePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const text of reader) {
        lineNumber += 1;
        if (lineNumber < start) continue;
        if (lineNumber > requestedEnd) { hasMore = true; break; }
        const size = Buffer.byteLength(text, "utf8") + 1;
        if (selected.length > 0 && returnedBytes + size > maxBytes) { truncated = true; hasMore = true; break; }
        selected.push({ line: lineNumber, text });
        returnedBytes += size;
      }
    } finally {
      reader.close();
      stream.destroy();
    }

    return jsonResult({
      project_id: project.projectId,
      path: resolved.relativePath,
      absolute_path: resolved.absolutePath,
      start_line: start,
      end_line: selected.at(-1)?.line ?? start - 1,
      total_lines: hasMore ? null : lineNumber,
      has_more: hasMore,
      truncated,
      size_bytes: fileStat.size,
      sha256: null,
      lines: selected,
    });
  } catch (err) {
    return jsonError("READ_FAILED", err instanceof Error ? err.message : String(err));
  }
}
