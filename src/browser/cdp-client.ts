import { requestSignal } from "../mcp/request-context.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class CdpClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  constructor(private readonly url: string, private readonly timeoutMs = 15_000) {}
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { this.close(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error("CDP connection timed out")), this.timeoutMs);
      ws.addEventListener("open", () => finish(), { once: true });
      ws.addEventListener("error", () => finish(new Error("CDP websocket connection failed")), { once: true });
      ws.addEventListener("message", event => this.onMessage(String(event.data)));
      ws.addEventListener("close", () => {
        finish(new Error("CDP websocket closed before connection"));
        this.rejectPending(new Error("CDP websocket closed"));
      });
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected) return Promise.reject(new Error("CDP websocket is not open"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out; execution outcome is unknown`));
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.ws!.send(JSON.stringify({ id, method, ...(params ? { params } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  close(): void {
    this.rejectPending(new Error("CDP connection closed"));
    this.ws?.close();
  }
  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  private onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
    else entry.resolve(message.result);
  }
}

type Lease = { client: CdpClient; ready: Promise<void>; users: number; timer?: ReturnType<typeof setTimeout> };
const clients = new Map<string, Lease>();

export async function withCdpClient<T>(url: string, operation: (client: CdpClient) => Promise<T>): Promise<T> {
  const signal = requestSignal();
  signal?.throwIfAborted();
  let lease = clients.get(url);
  if (lease && lease.users === 0 && !lease.client.connected) {
    clearTimeout(lease.timer);
    clients.delete(url);
    lease = undefined;
  }
  if (!lease) {
    if (clients.size >= 32) throw new Error("CDP connection capacity reached");
    const client = new CdpClient(url);
    lease = { client, ready: client.connect(), users: 0 };
    clients.set(url, lease);
  }
  clearTimeout(lease.timer);
  lease.users++;
  const cancel = () => lease!.client.close();
  signal?.addEventListener("abort", cancel, { once: true });
  try { await lease.ready; return await operation(lease.client); }
  finally {
    signal?.removeEventListener("abort", cancel);
    lease.users--;
    if (!lease.users) {
      const current = lease;
      current.timer = setTimeout(() => {
        current.client.close();
        if (clients.get(url) === current) clients.delete(url);
      }, 10_000);
      current.timer.unref?.();
    }
  }
}

export function closeCdpClients(): void {
  for (const lease of clients.values()) { clearTimeout(lease.timer); lease.client.close(); }
  clients.clear();
}
