export type ProjectId = string;

export type SandboxType = "host";

export type NetworkPolicy = "deny" | "ask" | "allow";

export type WritePolicy = "deny" | "confirm" | "allow";

export type ApprovalMode = "policy" | "catastrophic_only" | "never";

export type RedactionProfile = "default" | "strict";

export interface ProjectConfig {
  projectId: ProjectId;
  displayName: string;
  hostRoot: string;
  sandboxRoot: string;
  sandboxType: SandboxType;
  defaultShell: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  networkPolicy: NetworkPolicy;
  writePolicy: WritePolicy;
  approvalMode: ApprovalMode;
  tmuxSession?: string;
  deniedPaths: string[];
  redactionProfile: RedactionProfile;
}

export interface ChatContext {
  chatContextId: string;
  currentProjectId?: ProjectId;
  selectedAt?: string;
  selectedBy?: string;
  lastShellRunAt?: string;
}

export interface ShellRunInput {
  command: string;
  timeoutSeconds?: number;
  purpose?: string;
}

export type RiskLevel =
  | "read_only"
  | "local_compute"
  | "workspace_write"
  | "network_or_dependency"
  | "destructive_or_process_control"
  | "forbidden";

export interface ShellRunResult {
  projectId: ProjectId;
  cwd: string;
  command: string;
  purpose?: string;
  riskLevel: RiskLevel;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redactions: Redaction[];
}

export interface Redaction {
  type: string;
  count: number;
}

export interface AuditLogEntry {
  timestamp: string;
  chatContextId: string;
  tool: string;
  event?: string;
  projectId?: string;
  cwd?: string;
  command?: string;
  purpose?: string;
  riskLevel?: RiskLevel;
  enforcement?: "audit_only" | "blocked" | "approval_required";
  approvalRequestId?: string;
  approvalPolicy?: "ask" | "deny";
  approval?: {
    required: boolean;
    approved: boolean | null;
  };
  exitCode?: number | null;
  durationMs?: number;
  redactions?: Redaction[];
  error?: string;
}
