import { expect, it } from "vitest";
import { observeAfterAction } from "../../src/mcp/observation.js";

it("preserves a plain-text observation failure without suggesting action replay", async () => {
  const result = await observeAfterAction("type", async () => ({ isError: true, content: [{ type: "text", text: "device disconnected" }] }));
  expect(result.structuredContent).toMatchObject({ action_applied: true, retry_action: false, observation: { message: "device disconnected" } });
});

it("distinguishes observation exceptions from an action failure", async () => {
  const result = await observeAfterAction("click", async () => { throw new Error("capture failed"); });
  expect(result.structuredContent).toMatchObject({ action_applied: true, observation_ok: false, error: { message: "capture failed" } });
});
