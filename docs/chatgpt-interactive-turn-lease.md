# ChatGPT Interactive Turn Lease

## Purpose

Long-running ChatGPT turns that repeatedly call local-dev can eventually fail with a ChatGPT-side `Message delivery timed out. Please try again.` even when the underlying local work is healthy. The interactive turn lease limits how long a single interactive assistant turn may continue making local-dev calls.

The lease is a transport-safety boundary. It must not change implementation choices, scope, validation, ordering, or quality.

## Behavior

- The default lease duration is 20 minutes.
- Timing starts at the first local-dev tool call in an interactive ChatGPT assistant turn.
- Work proceeds normally until the lease expires.
- A tool call already in progress is never interrupted by the lease.
- After the lease expires, the next local-dev tool call is not executed.
- local-dev returns a normal control response with `status: "turn_paused"`.
- ChatGPT must not retry local-dev again in the same assistant turn.
- Existing background jobs continue running.
- ChatGPT returns control to the user.
- The next user message creates a new assistant turn with a fresh 20-minute lease.
- The original workflow resumes unchanged from the same point.
- Scheduled Tasks are excluded from the interactive lease.

The lease does not prescribe user-facing wording. ChatGPT decides how to explain progress to the user.

## Turn Identification

ChatGPT supplies `openai/session`, which identifies the chat rather than an individual assistant turn.

Secure Tunnel also forwards `X-Request-Id` values in this form:

```text
<request-group>/<request-suffix>
```

Multiple local-dev calls from the same assistant turn share the same request-group prefix. A later assistant turn receives a different prefix.

local-dev builds the lease key from:

```text
openai/session + X-Request-Id request-group
```

The request-group is injected into internal MCP request metadata as `local-dev/turn-request-id` before tool dispatch. This scopes the lease to one assistant turn while preserving chat-scoped project and browser state.

## Pause Response

When the lease has expired, the requested tool is skipped and local-dev returns a non-error control response similar to:

```json
{
  "status": "turn_paused",
  "reason": "interactive_turn_time_limit",
  "requested_tool": "shell.status",
  "tool_call_executed": false,
  "elapsed_seconds": 1212,
  "turn_limit_seconds": 1200,
  "retry_in_same_turn": false,
  "resume_on_next_user_turn": true,
  "preserve_workflow": true,
  "cancel_background_jobs": false
}
```

The accompanying instructions tell ChatGPT that:

- the pause is an intentional ChatGPT turn boundary rather than a local-dev failure;
- the requested tool call was not executed;
- local-dev must not be called again in the same assistant turn;
- the implementation plan, scope, and validation must remain unchanged;
- running background jobs must not be cancelled;
- the original workflow should resume after the next user message.

## Implementation

The implementation lives in:

- `src/mcp/turn-lease.ts`
- `src/mcp/server.ts`
- `tests/unit/turn-lease.test.ts`

`InteractiveTurnLeaseManager` stores the first-call timestamp for each turn key and marks that turn as paused once 1,200 seconds have elapsed.

The lease check happens before tool execution. A long-running tool call may cross the 20-minute boundary and still finish normally; execution pauses only when the next local-dev call arrives.

## Verification

The behavior is covered by focused unit tests for:

- Secure Tunnel request-group extraction;
- interactive-only lease metadata injection;
- per-turn lease isolation;
- the 20-minute default limit;
- non-error `turn_paused` response semantics.

Server and instruction tests, TypeScript typechecking, and the production build should also pass before deployment.

## Operational Notes

If `turn_paused` appears unexpectedly early, inspect whether Secure Tunnel is changing the `X-Request-Id` grouping semantics.

If ChatGPT continues calling local-dev after receiving `turn_paused`, check that the current server instructions are loaded. A new Branch/chat forces a new ChatGPT MCP context and is useful after server-instruction changes.

The 20-minute value is a turn boundary, not a work-planning heuristic. Do not skip tests, shorten implementation, or change task priority as the lease approaches expiry.
