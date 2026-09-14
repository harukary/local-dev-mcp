import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { jsonError, jsonResult, sha256 } from "./dev/common.js";
import { load as loadYaml } from "js-yaml";
import { applyWorkingDirectory } from "../../project/working-directory.js";

const DEFAULT_MAX_BYTES = 512 * 1024;

type SkillScope = "project" | "user" | "system";
type SkillOrigin = "common" | "private_user" | "project" | "system" | "unmanaged";

interface SkillRoot {
  scope: SkillScope;
  root: string;
  exists: boolean;
}

interface SkillEntry {
  name: string;
  description: string;
  path: string;
  relative_path: string;
  scope: SkillScope;
  origin: SkillOrigin;
  enabled: boolean;
}

export async function handleSkillsList(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; query?: string; scope?: SkillScope; detail?: "summary" | "full" }
) {
  const cwd = resolveSkillsCwd(ctx, chatContextId, args?.path);
  if (!cwd.ok) return jsonError(cwd.code, cwd.message, cwd.details);

  const roots = buildSkillRoots(cwd.cwd);
  const originManifest = loadOriginManifest();
  const skills: SkillEntry[] = [];
  const errors: Array<{ root: string; message: string }> = [];

  for (const root of roots) {
    if (!root.exists) continue;
    try {
      for (const filePath of await listSkillFiles(root.root, { excludeTopLevelDotSystem: root.scope === "user" })) {
        const metadata = await readSkillMetadata(filePath);
        skills.push({
          name: metadata.name || inferSkillName(root.root, filePath),
          description: metadata.description,
          path: filePath,
          relative_path: relative(root.root, filePath).replace(/\\/g, "/"),
          scope: root.scope,
          origin: resolveOrigin(root, filePath, originManifest),
          enabled: true,
        });
      }
    } catch (error) {
      errors.push({ root: root.root, message: error instanceof Error ? error.message : String(error) });
    }
  }

  skills.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const query = args?.query?.trim().toLowerCase();
  const filtered = skills.filter((skill) => {
    if (args?.scope && skill.scope !== args.scope) return false;
    return !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query);
  });
  const listed = args?.detail === "full"
    ? filtered
    : filtered.map(({ name, description, path, scope, origin }) => ({ name, description, path, scope, origin }));

  return jsonResult({
    cwd: cwd.cwd,
    roots,
    count: filtered.length,
    total_count: skills.length,
    skills: listed,
    errors,
    read_hint: "Call skills.read with the exact SKILL.md path returned by skills.list before applying a skill contract.",
  });
}

export async function handleSkillsRead(
  ctx: AppContext,
  args: { path?: string; max_bytes?: number }
) {
  const rawPath = args?.path?.trim();
  if (!rawPath) return jsonError("MISSING_PATH", "skills.read requires a SKILL.md path returned by skills.list.");

  const requestedPath = resolve(rawPath);
  if (!/\.(md|txt|json|yaml|yml|toml)$/i.test(requestedPath)) return jsonError("NOT_SKILL_FILE", "skills.read supports SKILL.md and text reference files inside a Skill directory.");

  try {
    const linkStat = await lstat(requestedPath);
    if (linkStat.isSymbolicLink()) {
      return jsonError("SKILL_SYMLINK_NOT_ALLOWED", "skills.read does not follow symbolic links.", { path: requestedPath });
    }
    const filePath = await realpath(requestedPath);
    const allowed = await resolveAllowedSkillFile(ctx, filePath);
    if (!allowed.ok) return jsonError(allowed.code, allowed.message, allowed.details);
    if (basename(filePath) !== "SKILL.md") {
      let directory = resolve(filePath, "..");
      while (directory !== allowed.root && isInside(allowed.root, directory) && !existsSync(join(directory, "SKILL.md"))) directory = resolve(directory, "..");
      if (!existsSync(join(directory, "SKILL.md"))) return jsonError("NOT_SKILL_FILE", "Reference must belong to a directory containing SKILL.md.");
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return jsonError("NOT_A_FILE", "Path is not a regular file.");

    const maxBytes = args?.max_bytes ?? DEFAULT_MAX_BYTES;
    if (fileStat.size > maxBytes) {
      return jsonError("FILE_TOO_LARGE", `Skill file is too large (${fileStat.size} bytes).`, { max_bytes: maxBytes });
    }

    const content = await readFile(filePath, "utf8");
    const metadata = parseSkillMetadata(content);
    return jsonResult({
      path: filePath,
      scope: allowed.scope,
      origin: resolveOrigin(allowed, filePath, loadOriginManifest()),
      name: metadata.name || inferSkillName(allowed.root, filePath),
      description: metadata.description,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      content,
    });
  } catch (error) {
    return jsonError("READ_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function resolveSkillsCwd(ctx: AppContext, chatContextId: string, inputPath?: string) {
  const rawPath = inputPath?.trim();
  if (!rawPath) {
    const currentProjectId = ctx.contextStore.getActiveProject?.(chatContextId, (projectId) => ctx.registry.has(projectId))
      ?? ctx.contextStore.getCurrentProject?.(chatContextId);
    const currentProject = currentProjectId ? ctx.registry.get(currentProjectId) : undefined;
    return { ok: true as const, cwd: resolve(currentProject ? applyWorkingDirectory(currentProject, ctx.contextStore.getWorkingDirectory?.(chatContextId)).hostRoot : process.cwd()) };
  }

  const base = activeProjectRoot(ctx, chatContextId) ?? process.cwd();
  const cwd = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
  const project = findContainingProject(ctx, cwd);
  if (!project) {
    return {
      ok: false as const,
      code: "PATH_OUTSIDE_REGISTERED_PROJECTS",
      message: "skills.list path must stay inside a registered project root.",
      details: { path: cwd, registered_projects: ctx.registry.getAll().map((p) => ({ project_id: p.projectId, root: p.hostRoot })) },
    };
  }
  return { ok: true as const, cwd };
}

function activeProjectRoot(ctx: AppContext, chatContextId: string): string | undefined {
  const projectId = ctx.contextStore.getActiveProject?.(chatContextId, (candidate) => ctx.registry.has(candidate))
    ?? ctx.contextStore.getCurrentProject?.(chatContextId);
  const project = projectId ? ctx.registry.get(projectId) : undefined;
  return project ? applyWorkingDirectory(project, ctx.contextStore.getWorkingDirectory?.(chatContextId)).hostRoot : undefined;
}

function findContainingProject(ctx: AppContext, targetPath: string): ProjectConfig | undefined {
  return ctx.registry.getAll().find((project) => isInside(resolve(project.hostRoot), targetPath));
}

async function resolveAllowedSkillFile(ctx: AppContext, filePath: string) {
  const containing = findContainingProject(ctx, filePath);
  const marker = `${process.platform === "win32" ? "\\" : "/"}.agents${process.platform === "win32" ? "\\" : "/"}skills${process.platform === "win32" ? "\\" : "/"}`;
  const markerIndex = filePath.lastIndexOf(marker);
  const nestedRoot = containing && markerIndex >= 0 ? filePath.slice(0, markerIndex + marker.length - 1) : undefined;
  const roots = [
    ...(nestedRoot ? [{ scope: "project" as const, root: nestedRoot }] : []),
    ...ctx.registry.getAll().map((project) => ({ scope: "project" as const, root: join(resolve(project.hostRoot), ".agents", "skills") })),
    { scope: "system" as const, root: codexSystemSkillsRoot() },
    { scope: "user" as const, root: codexSkillsRoot() },
  ];

  for (const root of roots) {
    try {
      const realRoot = await realpath(root.root);
      if (isInside(realRoot, filePath)) {
        return { ok: true as const, ...root, root: realRoot };
      }
    } catch {
      continue;
    }
  }

  return {
    ok: false as const,
    code: "PATH_OUTSIDE_SKILLS_ROOTS",
    message: "skills.read can only read SKILL.md files under registered project .agents/skills or CODEX_HOME/skills.",
    details: { path: filePath, allowed_roots: roots.map((root) => root.root) },
  };
}

function buildSkillRoots(cwd: string): SkillRoot[] {
  const roots = [
    { scope: "project" as const, root: join(cwd, ".agents", "skills") },
    { scope: "user" as const, root: codexSkillsRoot() },
    { scope: "system" as const, root: codexSystemSkillsRoot() },
  ];
  return roots.map((root) => ({ ...root, exists: existsSync(root.root) }));
}

function codexSkillsRoot(): string {
  return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".haru", ".codex"), "skills");
}

function codexSystemSkillsRoot(): string {
  return join(codexSkillsRoot(), ".system");
}

async function listSkillFiles(
  root: string,
  options: { excludeTopLevelDotSystem?: boolean } = {}
): Promise<string[]> {
  const result: string[] = [];
  await walk(root, result, root, options);
  return result;
}

async function walk(
  dir: string,
  result: string[],
  root: string,
  options: { excludeTopLevelDotSystem?: boolean }
) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (options.excludeTopLevelDotSystem && dir === root && entry.name === ".system") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill roots must not contain symbolic links: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      await walk(fullPath, result, root, options);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      result.push(fullPath);
    }
  }
}

type OriginManifest = { version: number; skills?: Record<string, "common" | "private_user"> };

function loadOriginManifest(): OriginManifest | null {
  const manifestPath = join(resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".haru", ".codex")), ".haru-context-origins.json");
  try {
    const parsed = JSON.parse(requireText(manifestPath)) as OriginManifest;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function requireText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function resolveOrigin(root: { scope: SkillScope; root: string }, filePath: string, manifest: OriginManifest | null): SkillOrigin {
  if (root.scope === "project") return "project";
  if (root.scope === "system") return "system";
  const relativePath = relative(root.root, filePath).replace(/\\/g, "/");
  const skillDir = relativePath.split("/").slice(0, -1).join("/");
  return manifest?.skills?.[skillDir] ?? "unmanaged";
}

async function readSkillMetadata(filePath: string): Promise<{ name: string; description: string }> {
  const info = await stat(filePath);
  const key = `${info.mtimeMs}:${info.size}`;
  const cached = metadataCache.get(filePath);
  if (cached?.key === key) return cached.metadata;
  const content = await readFile(filePath, "utf8");
  const metadata = parseSkillMetadata(content);
  if (metadataCache.size >= 1000) metadataCache.clear();
  metadataCache.set(filePath, { key, metadata });
  return metadata;
}
const metadataCache = new Map<string, { key: string; metadata: { name: string; description: string } }>();

function parseSkillMetadata(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };
  const parsed = loadYaml(match[1]);
  const frontmatter = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : "",
    description: typeof frontmatter.description === "string" ? frontmatter.description.trim() : "",
  };
}

function inferSkillName(root: string, filePath: string): string {
  const parts = relative(root, filePath).split(/[\\/]/);
  return parts.length >= 2 ? parts.at(-2) ?? "" : "";
}

function isInside(root: string, targetPath: string): boolean {
  const rel = relative(resolve(root), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
