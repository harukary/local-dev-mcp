import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { jsonError, jsonResult, sha256 } from "./dev/common.js";

const DEFAULT_MAX_BYTES = 512 * 1024;

type SkillScope = "project" | "common" | "system";

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
  enabled: boolean;
}

export async function handleSkillsList(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string }
) {
  const cwd = resolveSkillsCwd(ctx, chatContextId, args?.path);
  if (!cwd.ok) return jsonError(cwd.code, cwd.message, cwd.details);

  const roots = buildSkillRoots(cwd.cwd);
  const skills: SkillEntry[] = [];
  const errors: Array<{ root: string; message: string }> = [];

  for (const root of roots) {
    if (!root.exists) continue;
    try {
      for (const filePath of await listSkillFiles(root.root)) {
        const metadata = await readSkillMetadata(filePath);
        skills.push({
          name: metadata.name || inferSkillName(root.root, filePath),
          description: metadata.description,
          path: filePath,
          relative_path: relative(root.root, filePath).replace(/\\/g, "/"),
          scope: root.scope,
          enabled: true,
        });
      }
    } catch (error) {
      errors.push({ root: root.root, message: error instanceof Error ? error.message : String(error) });
    }
  }

  skills.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  return jsonResult({
    cwd: cwd.cwd,
    roots,
    count: skills.length,
    skills,
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

  const filePath = resolve(rawPath);
  if (basename(filePath) !== "SKILL.md") {
    return jsonError("NOT_SKILL_FILE", "skills.read only reads exact SKILL.md files. Pass a path returned by skills.list.");
  }

  const allowed = resolveAllowedSkillFile(ctx, filePath);
  if (!allowed.ok) return jsonError(allowed.code, allowed.message, allowed.details);

  try {
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
    return { ok: true as const, cwd: resolve(currentProject?.hostRoot ?? process.cwd()) };
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
  return projectId ? ctx.registry.get(projectId)?.hostRoot : undefined;
}

function findContainingProject(ctx: AppContext, targetPath: string): ProjectConfig | undefined {
  return ctx.registry.getAll().find((project) => isInside(resolve(project.hostRoot), targetPath));
}

function resolveAllowedSkillFile(ctx: AppContext, filePath: string) {
  const roots = [
    ...ctx.registry.getAll().map((project) => ({ scope: "project" as const, root: join(resolve(project.hostRoot), ".agents", "skills") })),
    { scope: "common" as const, root: commonSkillsRoot() },
    { scope: "system" as const, root: codexSystemSkillsRoot() },
  ];

  for (const root of roots) {
    if (isInside(root.root, filePath)) {
      return { ok: true as const, ...root };
    }
  }

  return {
    ok: false as const,
    code: "PATH_OUTSIDE_SKILLS_ROOTS",
    message: "skills.read can only read SKILL.md files under registered project .agents/skills, HARU_CONTEXT_HOME/skills, or CODEX_HOME/skills/.system.",
    details: { path: filePath, allowed_roots: roots.map((root) => root.root) },
  };
}

function buildSkillRoots(cwd: string): SkillRoot[] {
  const roots = [
    { scope: "project" as const, root: join(cwd, ".agents", "skills") },
    { scope: "common" as const, root: commonSkillsRoot() },
    { scope: "system" as const, root: codexSystemSkillsRoot() },
  ];
  return roots.map((root) => ({ ...root, exists: existsSync(root.root) }));
}

function commonSkillsRoot(): string {
  return resolve(process.env.HARU_CONTEXT_HOME?.trim() || join(homedir(), ".haru"), "skills");
}

function codexSystemSkillsRoot(): string {
  return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".haru", ".codex"), "skills", ".system");
}

async function listSkillFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  await walk(root, result);
  return result;
}

async function walk(dir: string, result: string[]) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, result);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      result.push(fullPath);
    }
  }
}

async function readSkillMetadata(filePath: string): Promise<{ name: string; description: string }> {
  const content = await readFile(filePath, "utf8");
  return parseSkillMetadata(content);
}

function parseSkillMetadata(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };
  const frontmatter = match[1];
  return {
    name: readFrontmatterString(frontmatter, "name"),
    description: readFrontmatterString(frontmatter, "description"),
  };
}

function readFrontmatterString(frontmatter: string, key: string): string {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function inferSkillName(root: string, filePath: string): string {
  const parts = relative(root, filePath).split(/[\\/]/);
  return parts.length >= 2 ? parts.at(-2) ?? "" : "";
}

function isInside(root: string, targetPath: string): boolean {
  const rel = relative(resolve(root), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
