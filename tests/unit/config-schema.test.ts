import { describe, it, expect } from "vitest";
import { validateProjectConfig } from "../../src/project/config-schema.js";
import type { RawProjectConfig } from "../../src/project/config-schema.js";

function makeRaw(overrides: Partial<RawProjectConfig> = {}): RawProjectConfig {
  return {
    display_name: "Test Project",
    host_root: "/Users/user/dev/test",
    sandbox_root: "/workspace/test",
    sandbox_type: "host",
    default_shell: "/bin/bash",
    default_timeout_seconds: 30,
    max_timeout_seconds: 300,
    network_policy: "ask",
    write_policy: "allow",
    denied_paths: [".env"],
    redaction_profile: "default",
    ...overrides,
  };
}

describe("Config Schema", () => {
  it("validates a correct config", () => {
    const config = validateProjectConfig("test", makeRaw());
    expect(config.projectId).toBe("test");
    expect(config.displayName).toBe("Test Project");
    expect(config.sandboxType).toBe("host");
    expect(config.approvalMode).toBe("policy");
  });

  it("rejects missing display_name", () => {
    expect(() => validateProjectConfig("test", makeRaw({ display_name: "" }))).toThrow("missing display_name");
  });

  it("rejects missing host_root", () => {
    expect(() => validateProjectConfig("test", makeRaw({ host_root: "" }))).toThrow("missing host_root");
  });

  it("rejects invalid sandbox_type", () => {
    expect(() => validateProjectConfig("test", makeRaw({ sandbox_type: "docker" }))).toThrow("invalid sandbox_type");
  });

  it("rejects invalid network_policy", () => {
    expect(() => validateProjectConfig("test", makeRaw({ network_policy: "maybe" }))).toThrow("invalid network_policy");
  });

  it("rejects invalid write_policy", () => {
    expect(() => validateProjectConfig("test", makeRaw({ write_policy: "maybe" }))).toThrow("invalid write_policy");
  });

  it("rejects invalid approval_mode", () => {
    expect(() => validateProjectConfig("test", makeRaw({ approval_mode: "maybe" }))).toThrow("invalid approval_mode");
  });

  it("rejects invalid timeout values", () => {
    expect(() => validateProjectConfig("test", makeRaw({ default_timeout_seconds: 500, max_timeout_seconds: 300 }))).toThrow("invalid timeout");
  });

  it("rejects invalid redaction_profile", () => {
    expect(() => validateProjectConfig("test", makeRaw({ redaction_profile: "none" }))).toThrow("invalid redaction_profile");
  });
});
