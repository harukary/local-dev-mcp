import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient, closeCdpClients, withCdpClient } from "../../src/browser/cdp-client.js";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  send = vi.fn();
  constructor(_url: string) { super(); Socket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}
afterEach(() => { closeCdpClients(); vi.unstubAllGlobals(); vi.useRealTimers(); Socket.instances = []; });

describe("CDP lifecycle", () => {
  it("rejects a connection that never opens", async () => {
    vi.stubGlobal("WebSocket", Socket); vi.useFakeTimers();
    const client = new CdpClient("ws://test", 50);
    const assertion = expect(client.connect()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(51); await assertion;
  });
  it("rejects commands without a response and closes the socket", async () => {
    vi.stubGlobal("WebSocket", Socket); vi.useFakeTimers();
    const client = new CdpClient("ws://test", 50);
    const ready = client.connect(); Socket.instances[0].open(); await ready;
    const assertion = expect(client.send("Runtime.evaluate")).rejects.toThrow("outcome is unknown");
    await vi.advanceTimersByTimeAsync(51); await assertion;
    expect(client.connected).toBe(false);
  });
  it("reuses a live target connection", async () => {
    vi.stubGlobal("WebSocket", Socket);
    const first = withCdpClient("ws://test", async client => client);
    Socket.instances[0].open(); const client = await first;
    expect(await withCdpClient("ws://test", async next => next)).toBe(client);
    expect(Socket.instances).toHaveLength(1);
  });
  it("matches responses by id and cancels their deadline", async () => {
    vi.stubGlobal("WebSocket", Socket); vi.useFakeTimers();
    const client = new CdpClient("ws://test", 50);
    const ready = client.connect(); Socket.instances[0].open(); await ready;
    const command = client.send("Page.getFrameTree");
    Socket.instances[0].reply({ id: 1, result: { value: 42 } });
    expect(await command).toEqual({ value: 42 });
    await vi.advanceTimersByTimeAsync(100); expect(client.connected).toBe(true);
    client.close();
  });
});
