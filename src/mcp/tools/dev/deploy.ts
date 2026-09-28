import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppContext } from "../../server.js";
import { resolveCredentialEnv } from "../../../shell/credential-env.js";
import { getActiveProject, jsonError, jsonResult } from "./common.js";
import { git } from "./git-core.js";

const EXPECTED_HEAD_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const DEPLOY_SCRIPT_NAME = "deploy:pages";
const PREVIEW_URL_PATTERN = /https:\/\/[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.pages\.dev\b/;

type DeployMode = "preflight" | "production";

export async function handlePagesDeploy(
  ctx: AppContext,
  chatContextId: string,
  args: { expected_head?: string },
  mode: DeployMode
) {
  const active = getActiveProject(ctx, chatContextId);
  if ("error" in active) return active.error;
  const project = active;

  const expectedHead = args.expected_head?.trim();
  if (!expectedHead || !EXPECTED_HEAD_PATTERN.test(expectedHead)) {
    return jsonError(
      "EXPECTED_HEAD_REQUIRED",
      "expected_head must be a 7-64 character hexadecimal Git commit id obtained from git.status or git.inspect."
    );
  }

  let currentHead: string;
  let resolvedExpectedHead: string;
  let gitTopLevel: string;
  try {
    const [{ stdout: current }, { stdout: expected }, { stdout: topLevel }] = await Promise.all([
      git(project, ["rev-parse", "--verify", "HEAD"]),
      git(project, ["rev-parse", "--verify", `${expectedHead}^{commit}`]),
      git(project, ["rev-parse", "--show-toplevel"]),
    ]);
    currentHead = String(current).trim();
    resolvedExpectedHead = String(expected).trim();
    gitTopLevel = String(topLevel).trim();
  } catch (error) {
    return jsonError("GIT_STATE_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }

  if (currentHead !== resolvedExpectedHead) {
    return jsonError("HEAD_MISMATCH", "expected_head does not match the deployment worktree HEAD.", {
      expected_head: resolvedExpectedHead,
      current_head: currentHead,
    });
  }

  try {
    if (realpathSync(gitTopLevel) !== realpathSync(project.hostRoot)) {
      return jsonError(
        "DEPLOY_WORKTREE_REQUIRED",
        "Deploy from the root of the selected Git worktree, not a nested archive or copied release directory.",
        { git_toplevel: gitTopLevel, selected_root: project.hostRoot }
      );
    }
  } catch (error) {
    return jsonError("DEPLOY_WORKTREE_CHECK_FAILED", error instanceof Error ? error.message : String(error));
  }

  const packagePath = join(project.hostRoot, "package.json");
  const pnpmLockPath = join(project.hostRoot, "pnpm-lock.yaml");
  if (!existsSync(packagePath) || !existsSync(pnpmLockPath)) {
    return jsonError(
      "DEPLOY_SCRIPT_UNSUPPORTED",
      "Typed Pages deployment currently requires package.json and pnpm-lock.yaml in the selected worktree root."
    );
  }

  let deployScript: unknown;
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    deployScript = packageJson.scripts?.[DEPLOY_SCRIPT_NAME];
  } catch (error) {
    return jsonError("PACKAGE_JSON_INVALID", error instanceof Error ? error.message : String(error));
  }

  if (typeof deployScript !== "string" || !deployScript.trim()) {
    return jsonError(
      "DEPLOY_SCRIPT_MISSING",
      `package.json must define a non-empty ${DEPLOY_SCRIPT_NAME} script before using the typed Pages deployment tool.`
    );
  }

  let credentialEnv: Record<string, string>;
  try {
    credentialEnv = await resolveCredentialEnv("bitwarden");
  } catch (error) {
    return jsonError("CREDENTIAL_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }

  const command = mode === "preflight"
    ? "CI=1 pnpm run deploy:pages -- --preflight-only"
    : "CI=1 pnpm run deploy:pages";
  const purpose = mode === "preflight"
    ? "Typed Cloudflare Pages deployment preflight"
    : "Typed Cloudflare Pages production deployment";

  const result = await ctx.shellRunner.run(
    project,
    {
      command,
      timeoutSeconds: Math.min(project.maxTimeoutSeconds, 240),
      purpose,
      credentialScope: "bitwarden",
      env: credentialEnv,
    },
    chatContextId
  );

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: mode === "preflight" ? "deploy.pages.preflight" : "deploy.pages",
    event: mode === "preflight" ? "pages_deploy_preflight_completed" : "pages_deploy_completed",
    projectId: result.projectId,
    cwd: result.cwd,
    command: result.command,
    purpose: result.purpose,
    credentialScope: result.credentialScope,
    riskLevel: result.riskLevel,
    enforcement: "audit_only",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    redactions: result.redactions,
    ...(result.timedOut ? { error: "Typed Pages deployment command timed out." } : {}),
  });

  const succeeded = result.exitCode === 0 && !result.timedOut;
  const deploymentUrl = mode === "production"
    ? result.stdout.match(PREVIEW_URL_PATTERN)?.[0] ?? null
    : null;

  if (!succeeded) {
    return {
      ...jsonError(
        mode === "preflight" ? "PAGES_PREFLIGHT_FAILED" : "PAGES_DEPLOY_FAILED",
        mode === "preflight"
          ? "Cloudflare Pages deployment preflight failed."
          : "Cloudflare Pages production deployment failed.",
        {
          project_id: result.projectId,
          cwd: result.cwd,
          head: currentHead,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          duration_ms: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          redactions: result.redactions,
        }
      ),
    };
  }

  return jsonResult({
    status: mode === "preflight" ? "ready" : "deployed",
    project_id: result.projectId,
    cwd: result.cwd,
    head: currentHead,
    deploy_script: DEPLOY_SCRIPT_NAME,
    duration_ms: result.durationMs,
    deployment_url: deploymentUrl,
    stdout: result.stdout,
    stderr: result.stderr,
    redactions: result.redactions,
    verified: true,
  });
}
