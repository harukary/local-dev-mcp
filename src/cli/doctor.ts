import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ProjectRegistry } from "../project/registry.js";

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  configPath: string;
}

type Status = "ok" | "warn" | "fail";

interface CheckResult {
  status: Status;
  label: string;
  detail: string;
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const results: CheckResult[] = [];

  results.push(checkNodeVersion());
  results.push(checkFile("package.json", "package.json"));
  results.push(checkFile("pnpm-lock.yaml", "pnpm lockfile"));
  results.push(await checkAgentDevice());
  if (process.platform === "darwin") results.push(await checkDeveloperToolsSecurity());
  results.push(checkSecureTunnelState());
  results.push(...await checkProjectConfig(options.configPath));

  for (const result of results) {
    const mark = result.status === "ok" ? "OK" : result.status === "warn" ? "WARN" : "FAIL";
    console.log(`${mark.padEnd(4)} ${result.label} - ${result.detail}`);
  }

  const failures = results.filter((result) => result.status === "fail").length;
  const warnings = results.filter((result) => result.status === "warn").length;
  console.log("");
  console.log(`Doctor summary: ${failures} failure(s), ${warnings} warning(s).`);
  return failures > 0 ? 1 : 0;
}

function checkNodeVersion(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 22) {
    return { status: "ok", label: "Node.js", detail: process.versions.node };
  }
  return {
    status: "fail",
    label: "Node.js",
    detail: `found ${process.versions.node}; Node.js 22 or newer is required`,
  };
}

function checkFile(path: string, label: string): CheckResult {
  return existsSync(path)
    ? { status: "ok", label, detail: resolve(path) }
    : { status: "fail", label, detail: `missing at ${resolve(path)}` };
}

async function checkAgentDevice(): Promise<CheckResult> {
  const binary = resolve("node_modules/.bin/agent-device");
  if (!existsSync(binary)) {
    return {
      status: "fail",
      label: "agent-device",
      detail: `project-local binary missing at ${binary}; run pnpm install`,
    };
  }
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const version = stdout.trim();
    return {
      status: version ? "ok" : "fail",
      label: "agent-device",
      detail: version ? `${version} (project-local)` : "project-local binary returned an empty version",
    };
  } catch (err) {
    return {
      status: "fail",
      label: "agent-device",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkDeveloperToolsSecurity(): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync("DevToolsSecurity", ["-status"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const detail = `${stdout}\n${stderr}`.trim();
    if (/currently enabled/i.test(detail)) {
      return { status: "ok", label: "physical iOS DevToolsSecurity", detail: "enabled" };
    }
    if (/currently disabled/i.test(detail)) {
      return {
        status: "warn",
        label: "physical iOS DevToolsSecurity",
        detail: "disabled; physical iOS XCTest requires: sudo DevToolsSecurity -enable",
      };
    }
    return { status: "warn", label: "physical iOS DevToolsSecurity", detail: detail || "status unknown" };
  } catch (err) {
    return {
      status: "warn",
      label: "physical iOS DevToolsSecurity",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkSecureTunnelState(): CheckResult {
  const inlineToken = process.env.LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN?.trim();
  if (inlineToken && inlineToken.length >= 32) {
    return { status: "ok", label: "Secure MCP Tunnel token", detail: "loaded from environment; value not printed" };
  }

  const tokenFile = process.env.LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE?.trim()
    || join(homedir(), ".local-dev-mcp", "openai-tunnel", "mcp-token");
  if (existsSync(tokenFile)) {
    return { status: "ok", label: "Secure MCP Tunnel token", detail: `file present: ${tokenFile}` };
  }

  return {
    status: "warn",
    label: "Secure MCP Tunnel token",
    detail: `missing at ${tokenFile}; HTTP MCP requires the tunnel token`,
  };
}

async function checkProjectConfig(configPath: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const absolute = resolve(configPath);
  if (!existsSync(configPath)) {
    return [{ status: "fail", label: "project config", detail: `missing at ${absolute}` }];
  }

  results.push({ status: "ok", label: "project config", detail: absolute });
  try {
    await access(dirname(absolute));
    const registry = await ProjectRegistry.load(configPath);
    const projects = registry.getAll();
    results.push({
      status: projects.length > 0 ? "ok" : "fail",
      label: "registered projects",
      detail: `${projects.length}`,
    });

    for (const project of projects) {
      const rootExists = existsSync(project.hostRoot);
      const isPlaceholder = project.hostRoot.includes("/absolute/path/to/");
      results.push({
        status: rootExists && !isPlaceholder ? "ok" : "fail",
        label: `project ${project.projectId}`,
        detail: rootExists
          ? `root exists: ${project.hostRoot}`
          : `root missing: ${project.hostRoot}`,
      });
      if (project.writePolicy === "allow" || project.approvalMode !== "policy") {
        results.push({
          status: "warn",
          label: `project ${project.projectId} policy`,
          detail: `write_policy=${project.writePolicy}, approval_mode=${project.approvalMode}`,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ status: "fail", label: "project config parse", detail: message });
  }

  return results;
}
