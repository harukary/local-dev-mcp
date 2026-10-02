import { describe, expect, it } from "vitest";
import {
  attachTurnRequestMeta,
  buildTurnPausedResponse,
  InteractiveTurnLeaseManager,
  resolveTurnLeaseKey,
  resolveTurnRequestId,
} from "../../src/mcp/turn-lease.js";

describe("interactive turn lease", () => {
  it("extracts the request-group prefix from Secure Tunnel X-Request-Id values", () => {
    expect(resolveTurnRequestId("7389d8db-cace-4280-ab09-8fbfa6ebec82/2jlw")).toBe(
      "7389d8db-cace-4280-ab09-8fbfa6ebec82",
    );
    expect(resolveTurnRequestId("wfr_da8a5d17d2b6475ea8142cdd760ec826/4r3b")).toBe(
      "wfr_da8a5d17d2b6475ea8142cdd760ec826",
    );
    expect(resolveTurnRequestId("plain-request-id")).toBe("plain-request-id");
    expect(resolveTurnRequestId("")).toBeUndefined();
    expect(resolveTurnRequestId("bad id/part")).toBeUndefined();
  });

  it("injects internal turn metadata only for interactive ChatGPT tool calls", () => {
    const interactive = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "workspace.read",
        arguments: { path: "README.md" },
        _meta: {
          "openai/session": "v1/session",
          "openai/subject": "subject",
        },
      },
      id: 1,
    };
    const attached = attachTurnRequestMeta(
      interactive,
      "7389d8db-cace-4280-ab09-8fbfa6ebec82/2jlw",
    ) as typeof interactive & {
      params: { _meta: Record<string, unknown> };
    };
    expect(attached.params._meta["local-dev/turn-request-id"]).toBe(
      "7389d8db-cace-4280-ab09-8fbfa6ebec82",
    );

    const scheduled = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "workspace.read",
        arguments: { path: "README.md" },
        _meta: {
          "openai/locale": "ja-JP",
          "openai/userAgent": "test",
          "openai/userLocation": { country: "JP" },
          timezone: "Asia/Tokyo",
        },
      },
      id: 2,
    };
    const scheduledAttached = attachTurnRequestMeta(
      scheduled,
      "7389d8db-cace-4280-ab09-8fbfa6ebec82/2jlw",
    ) as typeof scheduled & {
      params: { _meta: Record<string, unknown> };
    };
    expect(scheduledAttached.params._meta["local-dev/turn-request-id"]).toBeUndefined();
  });

  it("builds a lease key from chat context and turn request id", () => {
    expect(
      resolveTurnLeaseKey("chatgpt-session:v1/session", {
        "local-dev/turn-request-id": "turn-123",
      }),
    ).toBe("chatgpt-session:v1/session:turn-123");
    expect(resolveTurnLeaseKey("chatgpt-session:v1/session", {})).toBeUndefined();
  });

  it("pauses only after the limit and gives a new turn a fresh lease", () => {
    const manager = new InteractiveTurnLeaseManager(1_000);
    expect(manager.check("chat:turn-a", 10_000)).toEqual({
      paused: false,
      elapsedMs: 0,
      limitMs: 1_000,
    });
    expect(manager.check("chat:turn-a", 10_999).paused).toBe(false);

    const paused = manager.check("chat:turn-a", 11_000);
    expect(paused).toEqual({
      paused: true,
      elapsedMs: 1_000,
      limitMs: 1_000,
    });
    expect(manager.check("chat:turn-a", 10_500).paused).toBe(true);

    expect(manager.check("chat:turn-b", 11_000)).toEqual({
      paused: false,
      elapsedMs: 0,
      limitMs: 1_000,
    });
  });

  it("returns a non-error control response without prescribing user-facing wording", () => {
    const response = buildTurnPausedResponse("git.status", {
      paused: true,
      elapsedMs: 901_234,
      limitMs: 900_000,
    });
    const payload = response.structuredContent;

    expect(payload).toMatchObject({
      status: "turn_paused",
      reason: "interactive_turn_time_limit",
      requested_tool: "git.status",
      tool_call_executed: false,
      retry_in_same_turn: false,
      resume_on_next_user_turn: true,
      preserve_workflow: true,
      cancel_background_jobs: false,
      elapsed_seconds: 901,
      turn_limit_seconds: 900,
    });
    expect(response).not.toHaveProperty("isError");
    expect(payload.instructions).toContain("Do not retry this call");
    expect(payload.instructions).toContain("do not call any other local-dev tools");
    expect(payload.instructions).toContain("Do not change the implementation plan");
    expect(payload.instructions).toContain("resume the original workflow");
    expect(payload.instructions).not.toContain("tell the user");
    expect(payload.instructions).not.toContain("Briefly report");
  });
});
