import type { ProjectConfig, SandboxType, NetworkPolicy, WritePolicy, ApprovalMode, RedactionProfile } from '../types.js';

export interface RawProjectConfig {
  display_name: string;
  host_root: string;
  sandbox_root: string;
  sandbox_type: string;
  default_shell: string;
  default_timeout_seconds: number;
  max_timeout_seconds: number;
  network_policy: string;
  write_policy: string;
  approval_mode?: string;
  tmux_session?: string;
  denied_paths: string[];
  redaction_profile: string;
}

export interface RawConfig {
  projects: Record<string, RawProjectConfig>;
}

const validSandboxTypes: SandboxType[] = ["host"];
const validNetworkPolicies: NetworkPolicy[] = ["deny", "ask", "allow"];
const validWritePolicies: WritePolicy[] = ["deny", "confirm", "allow"];
const validApprovalModes: ApprovalMode[] = ["policy", "catastrophic_only", "never"];
const validRedactionProfiles: RedactionProfile[] = ["default", "strict"];

export function validateProjectConfig(
  projectId: string,
  raw: RawProjectConfig
): ProjectConfig {
  if (!raw.display_name) {
    throw new Error(`Project "${projectId}" is missing display_name`);
  }
  if (!raw.host_root) {
    throw new Error(`Project "${projectId}" is missing host_root`);
  }
  if (!raw.sandbox_root) {
    throw new Error(`Project "${projectId}" is missing sandbox_root`);
  }
  if (!validSandboxTypes.includes(raw.sandbox_type as SandboxType)) {
    throw new Error(
      `Project "${projectId}" has invalid sandbox_type "${raw.sandbox_type}". Must be one of: ${validSandboxTypes.join(", ")}`
    );
  }
  if (!validNetworkPolicies.includes(raw.network_policy as NetworkPolicy)) {
    throw new Error(
      `Project "${projectId}" has invalid network_policy "${raw.network_policy}"`
    );
  }
  if (!validWritePolicies.includes(raw.write_policy as WritePolicy)) {
    throw new Error(
      `Project "${projectId}" has invalid write_policy "${raw.write_policy}"`
    );
  }
  const approvalMode = (raw.approval_mode || "policy") as ApprovalMode;
  if (!validApprovalModes.includes(approvalMode)) {
    throw new Error(
      `Project "${projectId}" has invalid approval_mode "${raw.approval_mode}"`
    );
  }
  if (raw.default_timeout_seconds < 1 || raw.default_timeout_seconds > raw.max_timeout_seconds) {
    throw new Error(
      `Project "${projectId}" has invalid timeout values (default: ${raw.default_timeout_seconds}, max: ${raw.max_timeout_seconds})`
    );
  }
  if (!validRedactionProfiles.includes(raw.redaction_profile as RedactionProfile)) {
    throw new Error(
      `Project "${projectId}" has invalid redaction_profile "${raw.redaction_profile}"`
    );
  }

  return {
    projectId,
    displayName: raw.display_name,
    hostRoot: raw.host_root,
    sandboxRoot: raw.sandbox_root,
    sandboxType: raw.sandbox_type as SandboxType,
    defaultShell: raw.default_shell || "/bin/bash",
    defaultTimeoutSeconds: raw.default_timeout_seconds,
    maxTimeoutSeconds: raw.max_timeout_seconds,
    networkPolicy: raw.network_policy as NetworkPolicy,
    writePolicy: raw.write_policy as WritePolicy,
    approvalMode,
    tmuxSession: raw.tmux_session,
    deniedPaths: raw.denied_paths || [],
    redactionProfile: raw.redaction_profile as RedactionProfile,
  };
}
