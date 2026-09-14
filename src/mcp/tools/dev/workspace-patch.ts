import { mkdir, readFile, writeFile, stat, lstat, unlink, rename, link, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";
import type { AppContext } from "../../server.js";
import { getActiveProject, isProbablyBinary, jsonError, jsonResult, resolveProjectPath, sha256 } from "./common.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();

type WorkspacePatch = {
  path?: string; expected_sha256?: string; replacement?: string;
  old_text?: string; new_text?: string; replace_all?: boolean; unified_diff?: string;
};
type PlannedFile = {
  path: string; absolute: string; before: string | null; after: string | null;
  mode: string; occurrences_replaced?: number;
};
class PatchError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

async function readExisting(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new PatchError("SYMLINK_PATCH_UNSUPPORTED", "Patch the resolved regular file explicitly; symbolic links are not replaced.");
    if (!info.isFile()) throw new PatchError("NOT_A_FILE", "Patch target must be a regular file.");
    if (info.size > MAX_FILE_BYTES) throw new PatchError("FILE_TOO_LARGE", "Patch target exceeds 2 MiB.");
    const bytes = await readFile(path);
    if (bytes.length > MAX_FILE_BYTES || isProbablyBinary(bytes)) throw new PatchError("INVALID_TEXT_FILE", "Patch target must be bounded text.");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new PatchError("INVALID_UTF8", "Patch target must be valid UTF-8.");
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function handleWorkspacePatch(ctx: AppContext, chatContextId: string, args: { patches?: WorkspacePatch[]; dry_run?: boolean }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const queueKey = project.policyRoot ?? project.hostRoot;
  const previous = queues.get(queueKey) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const patches = args?.patches;
    if (!Array.isArray(patches) || patches.length === 0) return jsonError("MISSING_PATCHES", "workspace.patch requires at least one patch.");
    if (patches.length > 100) return jsonError("TOO_MANY_PATCHES", "At most 100 patches per call.");
    const dryRun = args.dry_run === true;
    const plan = new Map<string, PlannedFile>();
    const changed: string[] = [];
    let phase = "preflight";
    const load = async (path: string | undefined) => {
      if (!path?.trim()) throw new PatchError("MISSING_PATH", "Patch requires a file path.");
      const resolved = resolveProjectPath(project, path);
      if (!resolved.ok) throw new PatchError(resolved.code, resolved.message);
      let file = plan.get(resolved.absolutePath);
      if (!file) {
        const before = await readExisting(resolved.absolutePath);
        file = { path: resolved.relativePath, absolute: resolved.absolutePath, before, after: before, mode: "replacement" };
        plan.set(resolved.absolutePath, file);
      }
      return file;
    };
    try {
      for (const patch of patches) {
        if (!patch || typeof patch !== "object") throw new PatchError("INVALID_PATCH", "Each patch must be an object.");
        const modes = [patch.replacement !== undefined, patch.old_text !== undefined || patch.new_text !== undefined, patch.unified_diff !== undefined];
        if (modes.filter(Boolean).length !== 1) throw new PatchError("INVALID_PATCH", "Select exactly one of replacement, old_text/new_text, or unified_diff.");
        if (patch.unified_diff !== undefined) {
          if (typeof patch.unified_diff !== "string") throw new PatchError("INVALID_PATCH", "unified_diff must be a string.");
          if (/^(?:old mode|new mode|GIT binary patch|Binary files|rename from|copy from)(?: |$)/m.test(patch.unified_diff)) throw new PatchError("UNSUPPORTED_PATCH", "Mode-only, rename and binary patches require git.");
          if (/^new file mode (?!100644(?:\r?$))/m.test(patch.unified_diff)) throw new PatchError("UNSUPPORTED_PATCH", "Non-regular or executable file creation requires git.");
          let parsed;
          try { parsed = parsePatch(patch.unified_diff); }
          catch (error) { throw new PatchError("PATCH_SYNTAX", (error as Error).message); }
          if (!parsed.length) throw new PatchError("PATCH_PATHS_NOT_FOUND", "Unified diff did not contain file patches.");
          for (const item of parsed) {
            const oldPath = item.oldFileName === "/dev/null" ? null : item.oldFileName?.replace(/^a\//, "");
            const newPath = item.newFileName === "/dev/null" ? null : item.newFileName?.replace(/^b\//, "");
            if (!oldPath && !newPath) throw new PatchError("PATCH_PATHS_NOT_FOUND", "Unified diff requires a target path.");
            if (oldPath && newPath && oldPath !== newPath) throw new PatchError("UNSUPPORTED_PATCH", "Rename patches require git.");
            const file = await load(oldPath || newPath || undefined);
            if (!oldPath && file.after !== null) throw new PatchError("PATCH_CONFLICT", "New file already exists.", { path: file.path });
            if (oldPath && file.after === null) throw new PatchError("PATCH_CONFLICT", "Patch source does not exist.", { path: file.path });
            const after = applyPatch(file.after ?? "", item, { fuzzFactor: 0, autoConvertLineEndings: false });
            if (after === false) throw new PatchError("PATCH_CONFLICT", "Patch context does not match.", { path: file.path });
            file.after = newPath ? after : null;
            file.mode = "unified_diff";
          }
        } else {
          const file = await load(patch.path);
          const before = file.after ?? "";
          if (patch.expected_sha256 && sha256(before) !== patch.expected_sha256) throw new PatchError("PATCH_CONFLICT", "expected_sha256 mismatch", { path: file.path, actual_sha256: sha256(before) });
          if (patch.replacement !== undefined) {
            if (typeof patch.replacement !== "string") throw new PatchError("INVALID_PATCH", "replacement must be a string.");
            file.after = patch.replacement;
          } else {
            if (typeof patch.old_text !== "string" || !patch.old_text || typeof patch.new_text !== "string") throw new PatchError("INVALID_PATCH", "Text replacement requires nonempty old_text and string new_text.");
            if (file.after === null) throw new PatchError("PATCH_CONFLICT", "file does not exist", { path: file.path });
            const pieces = before.split(patch.old_text);
            const occurrences = pieces.length - 1;
            if (!occurrences) throw new PatchError("PATCH_CONFLICT", "old_text not found", { path: file.path });
            if (occurrences > 1 && patch.replace_all !== true) throw new PatchError("PATCH_CONFLICT", "old_text is ambiguous; set replace_all=true to replace all occurrences", { path: file.path, occurrences });
            file.after = patch.replace_all === true ? pieces.join(patch.new_text) : before.replace(patch.old_text, () => patch.new_text!);
            file.mode = "text_replace";
            file.occurrences_replaced = patch.replace_all === true ? occurrences : 1;
          }
        }
        let bytes = 0;
        for (const file of plan.values()) {
          const size = Buffer.byteLength(file.after ?? "");
          if (size > MAX_FILE_BYTES) throw new PatchError("FILE_TOO_LARGE", "Result exceeds 2 MiB.", { path: file.path });
          bytes += Buffer.byteLength(file.before ?? "") + size;
        }
        if (bytes > MAX_PLAN_BYTES) throw new PatchError("PATCH_TOO_LARGE", "Patch plan exceeds 16 MiB.");
      }
      const files = [...plan.values()].filter(f => f.before !== f.after);
      let diff = "";
      let truncated = false;
      for (const file of files) {
        const part = createTwoFilesPatch(file.before === null ? "/dev/null" : "a/" + file.path, file.after === null ? "/dev/null" : "b/" + file.path, file.before ?? "", file.after ?? "", undefined, undefined, { context: 3, timeout: 1000 });
        if (part === undefined || Buffer.byteLength(diff + part) > 64 * 1024) { truncated = true; continue; }
        diff += part;
      }
      if (!dryRun) {
        // Validate the complete source snapshot before writing, then recheck each target.
        for (const file of files) if (await readExisting(file.absolute) !== file.before) throw new PatchError("PATCH_CONFLICT", "File changed during preflight.", { path: file.path });
        phase = "write";
        for (const file of files) {
          const resolved = resolveProjectPath(project, file.path);
          if (!resolved.ok) throw new PatchError(resolved.code, resolved.message);
          if (await readExisting(file.absolute) !== file.before) throw new PatchError("PATCH_CONFLICT", "File changed before write.", { path: file.path });
          if (file.after === null) await unlink(file.absolute);
          else {
            await mkdir(dirname(file.absolute), { recursive: true });
            const temporary = `${file.absolute}.${randomUUID()}.tmp`;
            const mode = file.before === null ? 0o644 : (await stat(file.absolute)).mode & 0o777;
            try {
              await writeFile(temporary, file.after, { encoding: "utf8", flag: "wx", mode });
              if (await readExisting(file.absolute) !== file.before) throw new PatchError("PATCH_CONFLICT", "File changed before replacement.", { path: file.path });
              if (file.before === null) await link(temporary, file.absolute);
              else await rename(temporary, file.absolute);
            } finally { await rm(temporary, { force: true }); }
          }
          changed.push(file.path);
        }
      }
      return jsonResult({ applied: !dryRun, dry_run: dryRun, changed_files: dryRun ? files.map(f => f.path) : changed, files: files.map(f => ({ path: f.path, before_sha256: f.before === null ? null : sha256(f.before), after_sha256: f.after === null ? null : sha256(f.after), changed: true, mode: f.mode, occurrences_replaced: f.occurrences_replaced })), conflicts: [], diff, truncated });
    } catch (error) {
      const code = error instanceof PatchError ? error.code : "PATCH_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof PatchError ? error.details : undefined;
      return { ...jsonResult({ applied: false, dry_run: dryRun, partial: changed.length > 0, phase, changed_files: changed, conflicts: code === "PATCH_CONFLICT" ? [{ reason: message, ...(details as object) }] : [], error: { code, message, details } }), isError: true };
    }
  });
  queues.set(queueKey, operation);
  try { return await operation; }
  finally { if (queues.get(queueKey) === operation) queues.delete(queueKey); }
}
