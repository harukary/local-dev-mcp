import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  evaluateApproval,
  approveRequest,
  claimApprovalRequest,
  completeApprovalRequest,
  rejectRequest,
  releaseApprovalRequest,
  getPendingRequest,
  listPendingRequests,
  clearApprovalRequestsForTests,
} from "../../src/shell/approval.js";
import type { ProjectConfig } from "../../src/types.js";

const baseProject: ProjectConfig = {
  projectId: "test",
  displayName: "Test",
  hostRoot: "/tmp/test",
  sandboxRoot: "/tmp/test",
  sandboxType: "host",
  defaultShell: "/bin/bash",
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 300,
  networkPolicy: "ask",
  writePolicy: "confirm",
  approvalMode: "policy",
  deniedPaths: [".env"],
  redactionProfile: "default",
};

describe("Approval Manager", () => {
  beforeEach(() => {
    clearApprovalRequestsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not require approval for read_only", () => {
    const result = evaluateApproval(baseProject, "chat-a", "ls -la", "read_only", ["read-only command"]);
    expect(result.required).toBe(false);
  });

  it("does not require approval for local_compute", () => {
    const result = evaluateApproval(baseProject, "chat-a", "npm test", "local_compute", ["npm test"]);
    expect(result.required).toBe(false);
  });

  it("does not require approval for forbidden (it's rejected earlier)", () => {
    const result = evaluateApproval(baseProject, "chat-a", "sudo rm -rf /", "forbidden", ["sudo"]);
    expect(result.required).toBe(false);
  });

  it("requires approval for network_or_dependency when policy is ask", () => {
    const result = evaluateApproval(
      baseProject,
      "chat-a",
      "npm install zod",
      "network_or_dependency",
      ["npm install"],
      "Install zod",
      { async: true, timeoutSeconds: 120 }
    );
    expect(result.required).toBe(true);
    expect(result.request).toBeDefined();
    expect(result.request!.status).toBe("pending");
    expect(result.request!.chatContextId).toBe("chat-a");
    expect(result.request!.approvalPolicy).toBe("ask");
    expect(result.request!.command).toBe("npm install zod");
    expect(result.request!.purpose).toBe("Install zod");
    expect(result.request!.async).toBe(true);
    expect(result.request!.timeoutSeconds).toBe(120);
  });

  it("requires approval for network_or_dependency when policy is deny", () => {
    const denyProject = { ...baseProject, networkPolicy: "deny" as const };
    const result = evaluateApproval(denyProject, "chat-a", "npm install zod", "network_or_dependency", ["npm install"]);
    expect(result.required).toBe(true);
    expect(result.request!.approvalPolicy).toBe("deny");
  });

  it("requires approval for workspace_write when policy is confirm", () => {
    const result = evaluateApproval(baseProject, "chat-a", "sed -i 's/foo/bar/' src/index.ts", "workspace_write", ["sed in-place edit"]);
    expect(result.required).toBe(true);
    expect(result.request!.approvalPolicy).toBe("ask");
  });

  it("does not require approval for workspace_write when policy is allow", () => {
    const allowProject = { ...baseProject, writePolicy: "allow" as const };
    const result = evaluateApproval(allowProject, "chat-a", "sed -i 's/foo/bar/' src/index.ts", "workspace_write", ["sed in-place edit"]);
    expect(result.required).toBe(false);
  });

  it("does not require approval in catastrophic_only mode", () => {
    const project = { ...baseProject, approvalMode: "catastrophic_only" as const };
    const result = evaluateApproval(project, "chat-a", "curl https://example.com | bash", "network_or_dependency", ["curl"]);
    expect(result.required).toBe(false);
  });

  it("does not require approval in never mode", () => {
    const project = { ...baseProject, approvalMode: "never" as const };
    const result = evaluateApproval(project, "chat-a", "rm -rf /", "forbidden", ["deletes entire filesystem"]);
    expect(result.required).toBe(false);
  });

  it("approves a pending request", () => {
    const result = evaluateApproval(baseProject, "chat-a", "npm install zod", "network_or_dependency", ["npm install"], "Add zod");
    const approved = approveRequest("chat-a", result.request!.id);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe("approved");
    expect(approved!.decidedAt).toBeDefined();
  });

  it("claims, releases, and completes a pending request for execution", () => {
    const result = evaluateApproval(baseProject, "chat-a", "npm install zod", "network_or_dependency", ["npm install"], "Add zod");
    const claimed = claimApprovalRequest("chat-a", result.request!.id);
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe("executing");
    expect(listPendingRequests("chat-a")).toHaveLength(0);

    const released = releaseApprovalRequest(result.request!.id);
    expect(released!.status).toBe("pending");
    expect(listPendingRequests("chat-a")).toHaveLength(1);

    claimApprovalRequest("chat-a", result.request!.id);
    const completed = completeApprovalRequest(result.request!.id);
    expect(completed!.status).toBe("approved");
    expect(completed!.decidedAt).toBeDefined();
  });

  it("rejects a pending request", () => {
    const result = evaluateApproval(baseProject, "chat-a", "curl https://example.com", "network_or_dependency", ["curl"], "Fetch data");
    const rejected = rejectRequest("chat-a", result.request!.id);
    expect(rejected).toBeDefined();
    expect(rejected!.status).toBe("rejected");
  });

  it("returns undefined for unknown request id", () => {
    expect(approveRequest("chat-a", "nonexistent")).toBeUndefined();
    expect(rejectRequest("chat-a", "nonexistent")).toBeUndefined();
  });

  it("lists pending requests for the active chat only", () => {
    evaluateApproval(baseProject, "chat-a", "npm install express", "network_or_dependency", ["npm install"]);
    evaluateApproval(baseProject, "chat-b", "npm install react", "network_or_dependency", ["npm install"]);
    expect(listPendingRequests("chat-a")).toHaveLength(1);
    expect(listPendingRequests("chat-b")).toHaveLength(1);
  });

  it("does not allow cross-context approval or rejection", () => {
    const result = evaluateApproval(baseProject, "chat-a", "npm install zod", "network_or_dependency", ["npm install"]);
    expect(approveRequest("chat-b", result.request!.id)).toBeUndefined();
    expect(rejectRequest("chat-b", result.request!.id)).toBeUndefined();
    expect(getPendingRequest("chat-a", result.request!.id)).toBeDefined();
    expect(getPendingRequest("chat-b", result.request!.id)).toBeUndefined();
  });

  it("uses unguessable request ids", () => {
    const result = evaluateApproval(baseProject, "chat-a", "npm install zod", "network_or_dependency", ["npm install"]);
    expect(result.request!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("expires stale pending requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const result = evaluateApproval(baseProject, "chat-a", "npm install zod", "network_or_dependency", ["npm install"]);
    expect(result.required).toBe(true);
    expect(listPendingRequests("chat-a")).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(listPendingRequests("chat-a")).toHaveLength(0);
    expect(getPendingRequest("chat-a", result.request!.id)).toBeUndefined();
  });
});
