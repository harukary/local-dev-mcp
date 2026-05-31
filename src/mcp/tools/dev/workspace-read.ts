import { readFile, stat } from "node:fs/promises";
import type { AppContext } from "../../server.js";
import { getActiveProject, isProbablyBinary, jsonError, jsonResult, resolveProjectPath, sha256 } from "./common.js";

const DEFAULT_MAX_BYTES = 512 * 1024;

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
    const maxBytes = args?.max_bytes ?? DEFAULT_MAX_BYTES;
    if (fileStat.size > maxBytes) {
      return jsonError("FILE_TOO_LARGE", `File is too large (${fileStat.size} bytes).`, { max_bytes: maxBytes });
    }

    const bytes = await readFile(resolved.absolutePath);
    if (isProbablyBinary(bytes)) return jsonError("BINARY_FILE", "Binary files are not supported by workspace.read.");

    const content = bytes.toString("utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, args?.start_line ?? 1);
    const end = Math.min(lines.length, args?.end_line ?? lines.length);

    return jsonResult({
      project_id: project.projectId,
      path: resolved.relativePath,
      absolute_path: resolved.absolutePath,
      start_line: start,
      end_line: end,
      total_lines: lines.length,
      sha256: sha256(content),
      lines: lines.slice(start - 1, end).map((text, index) => ({ line: start + index, text })),
    });
  } catch (err) {
    return jsonError("READ_FAILED", err instanceof Error ? err.message : String(err));
  }
}
