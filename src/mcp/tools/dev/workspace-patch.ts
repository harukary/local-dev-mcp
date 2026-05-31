import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppContext } from "../../server.js";
import { getActiveProject, isProbablyBinary, jsonError, jsonResult, resolveProjectPath, sha256 } from "./common.js";
import { git, gitDiffForPaths } from "./git-core.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;

type WorkspacePatch = {
  path?: string;
  expected_sha256?: string;
  replacement?: string;
  unified_diff?: string;
};

async function readExisting(pathname: string): Promise<string> {
  const bytes = await readFile(pathname);
  if (bytes.byteLength > MAX_READ_BYTES) throw new Error(`file too large: ${bytes.byteLength} bytes`);
  if (isProbablyBinary(bytes)) throw new Error("binary file is not supported");
  return bytes.toString("utf8");
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:a|b)\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") paths.add(match[1]);
  }
  return Array.from(paths);
}

export async function handleWorkspacePatch(
  ctx: AppContext,
  chatContextId: string,
  args: { patches?: WorkspacePatch[]; dry_run?: boolean }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const patches = args?.patches ?? [];
  if (!Array.isArray(patches) || patches.length === 0) {
    return jsonError("MISSING_PATCHES", "workspace.patch requires at least one patch.");
  }

  const dryRun = args?.dry_run === true;
  const changed = new Set<string>();
  const files: unknown[] = [];
  const conflicts: unknown[] = [];

  try {
    for (const patch of patches) {
      if (patch.replacement !== undefined) {
        const resolved = resolveProjectPath(project, patch.path);
        if (!resolved.ok) return jsonError(resolved.code, resolved.message);
        const existed = existsSync(resolved.absolutePath);
        const before = existed ? await readExisting(resolved.absolutePath) : "";
        const beforeHash = sha256(before);
        if (patch.expected_sha256 && beforeHash !== patch.expected_sha256) {
          conflicts.push({ path: resolved.relativePath, reason: "expected_sha256 mismatch", actual_sha256: beforeHash });
          continue;
        }
        if (!dryRun) {
          await mkdir(dirname(resolved.absolutePath), { recursive: true });
          await writeFile(resolved.absolutePath, patch.replacement, "utf8");
        }
        changed.add(resolved.relativePath);
        files.push({
          path: resolved.relativePath,
          before_sha256: existed ? beforeHash : null,
          after_sha256: sha256(patch.replacement),
          changed: before !== patch.replacement,
          mode: "replacement",
        });
        continue;
      }

      if (patch.unified_diff !== undefined) {
        const paths = extractPatchPaths(patch.unified_diff);
        if (paths.length === 0) {
          return jsonError("PATCH_PATHS_NOT_FOUND", "Unified diff did not contain any file paths.");
        }
        for (const targetPath of paths) {
          const resolved = resolveProjectPath(project, targetPath);
          if (!resolved.ok) return jsonError(resolved.code, resolved.message);
          changed.add(resolved.relativePath);
        }
        await git(project, ["apply", "--check", "--whitespace=nowarn", "-"], patch.unified_diff);
        if (!dryRun) {
          await git(project, ["apply", "--whitespace=nowarn", "-"], patch.unified_diff);
        }
        files.push(...paths.map((path) => ({ path, changed: true, mode: "unified_diff" })));
        continue;
      }

      return jsonError("INVALID_PATCH", "Each patch requires replacement or unified_diff.");
    }

    if (conflicts.length > 0) {
      return jsonResult({ applied: false, dry_run: dryRun, changed_files: [], files, conflicts });
    }
    const diff = dryRun ? { diff: "", truncated: false } : await gitDiffForPaths(project, Array.from(changed));
    return jsonResult({ applied: !dryRun, dry_run: dryRun, changed_files: Array.from(changed), files, conflicts, ...diff });
  } catch (err) {
    return jsonError("PATCH_FAILED", err instanceof Error ? err.message : String(err));
  }
}
