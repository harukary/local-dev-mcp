const TURN_REQUEST_META_KEY = "local-dev/turn-request-id";
export const INTERACTIVE_TURN_LIMIT_MS = 15 * 60 * 1000;

type TurnLeaseState = {
  startedAtMs: number;
  paused: boolean;
};

export type TurnLeaseCheck =
  | {
      paused: false;
      elapsedMs: number;
      limitMs: number;
    }
  | {
      paused: true;
      elapsedMs: number;
      limitMs: number;
    };

export class InteractiveTurnLeaseManager {
  private readonly leases = new Map<string, TurnLeaseState>();

  constructor(private readonly limitMs = INTERACTIVE_TURN_LIMIT_MS) {}

  check(key: string, nowMs = Date.now()): TurnLeaseCheck {
    let lease = this.leases.get(key);
    if (!lease) {
      lease = { startedAtMs: nowMs, paused: false };
      this.leases.set(key, lease);
      this.pruneIfNeeded(nowMs);
      return { paused: false, elapsedMs: 0, limitMs: this.limitMs };
    }

    const elapsedMs = Math.max(0, nowMs - lease.startedAtMs);
    if (lease.paused || elapsedMs >= this.limitMs) {
      lease.paused = true;
      return { paused: true, elapsedMs, limitMs: this.limitMs };
    }

    return { paused: false, elapsedMs, limitMs: this.limitMs };
  }

  private pruneIfNeeded(nowMs: number): void {
    if (this.leases.size <= 1024) return;
    const retentionMs = Math.max(this.limitMs * 4, 60 * 60 * 1000);
    for (const [key, lease] of this.leases) {
      if (nowMs - lease.startedAtMs > retentionMs) this.leases.delete(key);
    }
  }
}

export function resolveTurnRequestId(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return undefined;

  const separator = trimmed.indexOf("/");
  const requestGroup = separator === -1 ? trimmed : trimmed.slice(0, separator);
  if (!requestGroup || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestGroup)) return undefined;
  return requestGroup;
}

export function attachTurnRequestMeta(parsed: unknown, headerValue: string | string[] | undefined): unknown {
  const turnRequestId = resolveTurnRequestId(headerValue);
  if (!turnRequestId || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;

  const message = parsed as Record<string, unknown>;
  if (message.method !== "tools/call") return parsed;

  const params = message.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return parsed;

  const paramsRecord = params as Record<string, unknown>;
  const meta = paramsRecord._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return parsed;

  const metaRecord = meta as Record<string, unknown>;
  const openAiSession = metaRecord["openai/session"];
  if (typeof openAiSession !== "string" || !openAiSession) return parsed;

  metaRecord[TURN_REQUEST_META_KEY] = turnRequestId;
  return parsed;
}

export function resolveTurnLeaseKey(
  chatContextId: string,
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const turnRequestId = meta?.[TURN_REQUEST_META_KEY];
  if (typeof turnRequestId !== "string" || !turnRequestId) return undefined;
  return `${chatContextId}:${turnRequestId}`;
}

export function buildTurnPausedResponse(toolName: string, check: Extract<TurnLeaseCheck, { paused: true }>) {
  const elapsedSeconds = Math.floor(check.elapsedMs / 1000);
  const limitSeconds = Math.floor(check.limitMs / 1000);
  const payload = {
    status: "turn_paused",
    reason: "interactive_turn_time_limit",
    requested_tool: toolName,
    tool_call_executed: false,
    elapsed_seconds: elapsedSeconds,
    turn_limit_seconds: limitSeconds,
    retry_in_same_turn: false,
    resume_on_next_user_turn: true,
    preserve_workflow: true,
    cancel_background_jobs: false,
    instructions:
      "This is an intentional ChatGPT turn-level pause, not a local-dev failure. " +
      "The current assistant turn has exceeded the interactive local-dev time limit, and continuing to call local-dev in the same turn increases the risk of ChatGPT message delivery timeout. " +
      "The requested tool call was not executed. Do not retry this call and do not call any other local-dev tools in the current assistant turn. " +
      "Do not change the implementation plan, reduce scope, skip validation, cancel already-running background jobs, or treat unfinished work as failed. " +
      "Return control to the user now. When the user sends the next message, resume the original workflow from the same point and continue normally.",
  };
  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
