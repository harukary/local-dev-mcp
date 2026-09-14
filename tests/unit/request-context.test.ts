import { expect, it } from "vitest";
import { operationSignal, requestSignal, withRequestSignal } from "../../src/mcp/request-context.js";

it("isolates concurrent request cancellation and combines it with operation deadlines", async () => {
  const a = new AbortController();
  const b = new AbortController();
  await Promise.all([
    withRequestSignal(a.signal, async () => {
      const signal = operationSignal(1000);
      await Promise.resolve();
      a.abort();
      expect(signal.aborted).toBe(true);
    }),
    withRequestSignal(b.signal, async () => {
      await Promise.resolve();
      expect(requestSignal()).toBe(b.signal);
      expect(operationSignal(1000).aborted).toBe(false);
    }),
  ]);
  expect(requestSignal()).toBeUndefined();
});
