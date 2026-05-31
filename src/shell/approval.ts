import { randomUUID } from "node:crypto";
import type { RiskLevel, ProjectConfig } from "../types.js";

export interface ApprovalRequest {
  id: string;
  chatContextId: string;
  projectId: string;
  command: string;
  riskLevel: RiskLevel;
  purpose?: string;
  async?: boolean;
  timeoutSeconds?: number;
  reasons: string[];
  approvalPolicy: "ask" | "deny";
  status: "pending" | "executing" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
}

export interface ApprovalDecision {
  required: boolean;
  request?: ApprovalRequest;
}

const REQUESTS_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const pendingRequests = new Map<string, ApprovalRequest>();
let gcTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGc(): void {
  if (gcTimer) return;
  gcTimer = setTimeout(() => {
    gcTimer = null;
    cleanupExpiredRequests();
    if (pendingRequests.size > 0) {
      scheduleGc();
    }
  }, REQUESTS_MAX_AGE_MS);
}

function cleanupExpiredRequests(): void {
  const cutoff = Date.now() - REQUESTS_MAX_AGE_MS;
  for (const [id, req] of pendingRequests) {
    const referenceTime = new Date(req.decidedAt ?? req.createdAt).getTime();
    if (referenceTime < cutoff) {
      pendingRequests.delete(id);
    }
  }
}

function generateId(): string {
  return randomUUID();
}

export function evaluateApproval(
  project: ProjectConfig,
  chatContextId: string,
  command: string,
  riskLevel: RiskLevel,
  reasons: string[],
  purpose?: string,
  options?: { async?: boolean; timeoutSeconds?: number }
): ApprovalDecision {
  if (project.approvalMode === "never" || project.approvalMode === "catastrophic_only") {
    return { required: false };
  }

  switch (riskLevel) {
    case "read_only":
    case "local_compute":
      return { required: false };

    case "forbidden":
      return { required: false };

    case "workspace_write":
      if (project.writePolicy === "allow") {
        return { required: false };
      }
      return createRequest(
        project,
        chatContextId,
        command,
        riskLevel,
        reasons,
        purpose,
        options,
        project.writePolicy === "deny" ? "deny" : "ask"
      );

    case "network_or_dependency":
      if (project.networkPolicy === "allow") {
        return { required: false };
      }
      return createRequest(
        project,
        chatContextId,
        command,
        riskLevel,
        reasons,
        purpose,
        options,
        project.networkPolicy === "deny" ? "deny" : "ask"
      );

    case "destructive_or_process_control":
      return createRequest(project, chatContextId, command, riskLevel, reasons, purpose, options, "ask");

    default:
      return createRequest(project, chatContextId, command, riskLevel, reasons, purpose, options, "ask");
  }
}

function createRequest(
  project: ProjectConfig,
  chatContextId: string,
  command: string,
  riskLevel: RiskLevel,
  reasons: string[],
  purpose: string | undefined,
  options: { async?: boolean; timeoutSeconds?: number } | undefined,
  approvalPolicy: "ask" | "deny"
): ApprovalDecision {
  cleanupExpiredRequests();
  const request: ApprovalRequest = {
    id: generateId(),
    chatContextId,
    projectId: project.projectId,
    command,
    riskLevel,
    purpose,
    async: options?.async,
    timeoutSeconds: options?.timeoutSeconds,
    reasons,
    approvalPolicy,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  pendingRequests.set(request.id, request);
  scheduleGc();
  return { required: true, request };
}

export function approveRequest(chatContextId: string, requestId: string): ApprovalRequest | undefined {
  cleanupExpiredRequests();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "pending" || req.chatContextId !== chatContextId) return undefined;
  req.status = "approved";
  req.decidedAt = new Date().toISOString();
  scheduleGc();
  return req;
}

export function claimApprovalRequest(chatContextId: string, requestId: string): ApprovalRequest | undefined {
  cleanupExpiredRequests();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "pending" || req.chatContextId !== chatContextId) return undefined;
  req.status = "executing";
  return req;
}

export function completeApprovalRequest(requestId: string): ApprovalRequest | undefined {
  cleanupExpiredRequests();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "executing") return undefined;
  req.status = "approved";
  req.decidedAt = new Date().toISOString();
  scheduleGc();
  return req;
}

export function releaseApprovalRequest(requestId: string): ApprovalRequest | undefined {
  cleanupExpiredRequests();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "executing") return undefined;
  req.status = "pending";
  req.decidedAt = undefined;
  scheduleGc();
  return req;
}

export function rejectRequest(chatContextId: string, requestId: string): ApprovalRequest | undefined {
  cleanupExpiredRequests();
  const req = pendingRequests.get(requestId);
  if (!req || req.status !== "pending" || req.chatContextId !== chatContextId) return undefined;
  req.status = "rejected";
  req.decidedAt = new Date().toISOString();
  scheduleGc();
  return req;
}

export function getPendingRequest(chatContextId: string, requestId: string): ApprovalRequest | undefined {
  cleanupExpiredRequests();
  const req = pendingRequests.get(requestId);
  return req && req.chatContextId === chatContextId ? req : undefined;
}

export function listPendingRequests(chatContextId: string): ApprovalRequest[] {
  cleanupExpiredRequests();
  return Array.from(pendingRequests.values()).filter((r) => r.status === "pending" && r.chatContextId === chatContextId);
}

export function clearApprovalRequestsForTests(): void {
  pendingRequests.clear();
  if (gcTimer) {
    clearTimeout(gcTimer);
    gcTimer = null;
  }
}

export function getRequestStatus(
  command: string,
  riskLevel: RiskLevel,
  reasons: string[],
  approvalPolicy: "ask" | "deny" = "ask"
): string {
  switch (riskLevel) {
    case "read_only":
      return "This is a read-only operation. No approval needed.";
    case "local_compute":
      return "This is a local compute operation. No approval needed.";
    case "workspace_write":
      return approvalPolicy === "deny"
        ? `This is a high-risk workspace write operation and requires explicit approval. Reason: ${reasons.join(", ")}`
        : `This operation modifies files in the workspace. Reason: ${reasons.join(", ")}`;
    case "network_or_dependency":
      return approvalPolicy === "deny"
        ? `This is a high-risk network operation and requires explicit approval. Reason: ${reasons.join(", ")}`
        : `This operation accesses the network. Reason: ${reasons.join(", ")}`;
    case "destructive_or_process_control":
      return `This operation is potentially destructive. Reason: ${reasons.join(", ")}`;
    case "forbidden":
      return `This operation is not allowed. Reason: ${reasons.join(", ")}`;
    default:
      return "Unknown risk level.";
  }
}
