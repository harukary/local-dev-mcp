import { describe, it, expect } from "vitest";

describe("MCP Server Connection", () => {
  it.skip("integration test requires manual stdio setup", () => {
    // Integration test is done manually via direct server runs.
    // See scripts/tunnel.sh --doctor for the Secure MCP Tunnel preflight workflow.
    expect(true).toBe(true);
  });
});
