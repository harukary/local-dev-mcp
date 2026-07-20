import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProjectRegistry } from "../project/registry.js";

export interface DoctorOptions {
  configPath: string;
  envPath: string;
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
  results.push(checkEnv(options.envPath));
  results.push(checkPublicOrigin());
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

function checkEnv(path: string): CheckResult {
  if (!existsSync(path)) {
    return { status: "warn", label: ".env", detail: `missing at ${resolve(path)}` };
  }
  if (!process.env.LOCAL_DEV_MCP_PASSPHRASE) {
    return {
      status: "warn",
      label: "LOCAL_DEV_MCP_PASSPHRASE",
      detail: `${resolve(path)} exists, but passphrase is not loaded`,
    };
  }
  return {
    status: "ok",
    label: "LOCAL_DEV_MCP_PASSPHRASE",
    detail: "present; value not printed",
  };
}

function checkPublicOrigin(): CheckResult {
  const raw = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN?.trim();
  if (!raw) {
    return {
      status: "warn",
      label: "LOCAL_DEV_MCP_PUBLIC_ORIGIN",
      detail: "not set; local HTTP is fine, but ChatGPT needs a reachable HTTPS origin",
    };
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      return {
        status: "warn",
        label: "LOCAL_DEV_MCP_PUBLIC_ORIGIN",
        detail: "set, but not HTTPS",
      };
    }
    return { status: "ok", label: "LOCAL_DEV_MCP_PUBLIC_ORIGIN", detail: url.origin };
  } catch {
    return {
      status: "fail",
      label: "LOCAL_DEV_MCP_PUBLIC_ORIGIN",
      detail: "invalid URL",
    };
  }
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
