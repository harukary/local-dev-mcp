import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProjectConfig } from "../types.js";

export type WorkingDirectoryResolution =
  | { ok: true; relativePath: string; hostRoot: string; sandboxRoot: string }
  | { ok: false; code: "WORKING_DIRECTORY_INVALID" | "WORKING_DIRECTORY_OUTSIDE_PROJECT" | "WORKING_DIRECTORY_NOT_FOUND"; message: string };

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel);
}

export function resolveWorkingDirectory(project: ProjectConfig, input?: string): WorkingDirectoryResolution {
  const raw = input?.trim() || ".";
  if (isAbsolute(raw)) {
    return {
      ok: false,
      code: "WORKING_DIRECTORY_INVALID",
      message: "working_dir must be relative to the selected project root.",
    };
  }

  const baseHostRoot = resolve(project.hostRoot);
  const hostRoot = resolve(baseHostRoot, raw);
  if (isOutside(baseHostRoot, hostRoot)) {
    return {
      ok: false,
      code: "WORKING_DIRECTORY_OUTSIDE_PROJECT",
      message: "working_dir must stay inside the selected project root.",
    };
  }
  if (!existsSync(hostRoot) || !statSync(hostRoot).isDirectory()) {
    return {
      ok: false,
      code: "WORKING_DIRECTORY_NOT_FOUND",
      message: `working_dir does not exist or is not a directory: ${raw}`,
    };
  }

  const realBaseHostRoot = realpathSync(baseHostRoot);
  const realHostRoot = realpathSync(hostRoot);
  if (isOutside(realBaseHostRoot, realHostRoot)) {
    return {
      ok: false,
      code: "WORKING_DIRECTORY_OUTSIDE_PROJECT",
      message: "working_dir resolves outside the selected project root.",
    };
  }

  const relativePath = relative(baseHostRoot, hostRoot).replace(/\\/g, "/") || ".";
  const sandboxRoot = relativePath === "."
    ? resolve(project.sandboxRoot)
    : resolve(project.sandboxRoot, relativePath);
  return { ok: true, relativePath, hostRoot, sandboxRoot };
}

export function applyWorkingDirectory(project: ProjectConfig, workingDirectory?: string): ProjectConfig {
  const relativePath = workingDirectory?.trim() || ".";
  if (relativePath === ".") return project;
  return {
    ...project,
    policyRoot: project.policyRoot ?? project.hostRoot,
    hostRoot: resolve(project.hostRoot, relativePath),
    sandboxRoot: resolve(project.sandboxRoot, relativePath),
  };
}
