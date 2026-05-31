import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../../server.js";
import { getActiveProject, jsonResult } from "./common.js";

export async function handleProjectInspect(ctx: AppContext, chatContextId: string) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const root = project.hostRoot;
  const files = {
    package_json: existsSync(join(root, "package.json")),
    pnpm_lock: existsSync(join(root, "pnpm-lock.yaml")),
    package_lock: existsSync(join(root, "package-lock.json")),
    yarn_lock: existsSync(join(root, "yarn.lock")),
    bun_lock: existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")),
    tsconfig: existsSync(join(root, "tsconfig.json")),
  };
  let packageJson: Record<string, unknown> | null = null;
  if (files.package_json) {
    try { packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { /* ignore */ }
  }
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts as Record<string, unknown> : {};
  const deps = {
    ...(packageJson?.dependencies && typeof packageJson.dependencies === "object" ? packageJson.dependencies as Record<string, unknown> : {}),
    ...(packageJson?.devDependencies && typeof packageJson.devDependencies === "object" ? packageJson.devDependencies as Record<string, unknown> : {}),
  };
  const knownFrameworks = ["next", "react", "react-native", "expo", "vite", "svelte", "vue", "nuxt", "astro", "fastify", "express", "vitest", "jest", "playwright"];
  const frameworks = Object.keys(deps).filter((name) => knownFrameworks.includes(name));
  const packageManager = files.pnpm_lock ? "pnpm" : files.package_lock ? "npm" : files.yarn_lock ? "yarn" : files.bun_lock ? "bun" : "unknown";
  return jsonResult({
    project_id: project.projectId,
    display_name: project.displayName,
    cwd: project.hostRoot,
    package_manager: packageManager,
    files,
    scripts,
    frameworks,
    likely_commands: {
      install: packageManager === "unknown" ? undefined : `${packageManager} install`,
      test: scripts.test ? `${packageManager} test` : undefined,
      typecheck: scripts.typecheck ? `${packageManager} run typecheck` : undefined,
      dev: scripts.dev ? `${packageManager} run dev` : undefined,
    },
    policies: {
      denied_paths: project.deniedPaths,
      write_policy: project.writePolicy,
      network_policy: project.networkPolicy,
      approval_mode: project.approvalMode,
    },
  });
}
