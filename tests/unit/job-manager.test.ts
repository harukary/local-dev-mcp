import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleShellStatus } from "../../src/mcp/tools/shell-status.js";
import { clearJobsForTests, cancelJob, cleanupOldPersistedJobsForTests, getJob, setJobRetentionTtlForTests, setPersistedJobRetentionForTests, startJob } from "../../src/shell/job-manager.js";
import type { ProjectConfig } from "../../src/types.js";

let projectRoot = "";

const project: ProjectConfig = {
  projectId: "test",
  displayName: "Test",
  hostRoot: "",
  sandboxRoot: "",
  sandboxType: "host",
  defaultShell: "/bin/bash",
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 300,
  networkPolicy: "ask",
  writePolicy: "confirm",
  approvalMode: "catastrophic_only",
  deniedPaths: [],
  redactionProfile: "default",
};

function touchFile(path: string, time: Date): void {
  utimesSync(path, time, time);
}

function getFileExists(path: string): boolean {
  return existsSync(path);
}

async function waitForJobCompletion(jobId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const job = getJob(jobId);
    if (job?.status && job.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not complete in time`);
}

describe("job retention", () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "job-manager-test-"));
    project.hostRoot = projectRoot;
    project.sandboxRoot = projectRoot;
    project.deniedPaths = [];
    clearJobsForTests();
    setJobRetentionTtlForTests(50);
    setPersistedJobRetentionForTests(7 * 24 * 60 * 60 * 1000);
  });

  afterEach(() => {
    clearJobsForTests();
    setJobRetentionTtlForTests(5 * 60 * 1000);
    setPersistedJobRetentionForTests(7 * 24 * 60 * 60 * 1000);
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = "";
    }
  });

  it("blocks forbidden-classified async commands even in catastrophic_only mode", () => {
    project.deniedPaths = [".env"];

    const result = startJob(project, "cat .env");

    expect("error" in result).toBe(true);
    expect("error" in result ? result.error : "").toContain("Forbidden command");
  });

  it("keeps completed jobs available after the in-memory TTL expires", async () => {
    const result = startJob(project, "echo retained");
    if ("error" in result) {
      throw new Error(result.error);
    }
    const jobId = result.id;

    await waitForJobCompletion(jobId);
    const completed = getJob(jobId);
    expect(completed).toBeDefined();
    expect(completed!.status).not.toBe("running");
    expect(completed!.stdout).toContain("retained");

    await new Promise((resolve) => setTimeout(resolve, 75));
    const persisted = getJob(jobId);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe(completed!.status);
    expect(persisted!.stdout).toContain("retained");
    expect(persisted!.process).toBeUndefined();
  });

  it("cleans up persisted jobs older than seven days", () => {
    const jobsDir = join(process.cwd(), ".local-dev-mcp", "jobs");
    const oldPath = join(jobsDir, "old.json");
    const freshPath = join(jobsDir, "fresh.json");
    const now = Date.now();

    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(oldPath, "{}", "utf-8");
    writeFileSync(freshPath, "{}", "utf-8");

    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    touchFile(oldPath, eightDaysAgo);
    touchFile(freshPath, oneDayAgo);

    cleanupOldPersistedJobsForTests(now);

    expect(getFileExists(oldPath)).toBe(false);
    expect(getFileExists(freshPath)).toBe(true);
  });

  it("returns persisted job output through shell.status after the in-memory TTL expires", async () => {
    const result = startJob(project, "echo status-persisted");
    if ("error" in result) {
      throw new Error(result.error);
    }
    const jobId = result.id;

    await waitForJobCompletion(jobId);
    await new Promise((resolve) => setTimeout(resolve, 75));

    const statusResult = await handleShellStatus({ job_id: jobId });
    expect(statusResult.isError).toBeUndefined();

    const payload = JSON.parse(statusResult.content[0].text);
    expect(payload.job_id).toBe(jobId);
    expect(payload.status).toBe("succeeded");
    expect(payload.stdout).toContain("status-persisted");
  });

  it("exposes running stdout through shell.status", async () => {
    const result = startJob(project, `node -e "console.log('live-output'); setTimeout(() => {}, 500)"`);
    if ("error" in result) {
      throw new Error(result.error);
    }

    const jobId = result.id;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const job = getJob(jobId);
      if (job?.stdout.includes("live-output")) {
        expect(job.status).toBe("running");
        expect(job.stderr).toBe("");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(getJob(jobId)?.stdout).toContain("live-output");
    expect(cancelJob(jobId)).toBe(true);

    const endDeadline = Date.now() + 2000;
    while (Date.now() < endDeadline) {
      const job = getJob(jobId);
      if (job && job.status !== "running") {
        expect(job.status).toBe("canceled");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Job ${jobId} did not cancel in time`);
  });
});
