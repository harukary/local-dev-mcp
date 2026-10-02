# `project.select` agent-instruction resolution

Last verified: 2026-10-02

## Purpose

Interactive ChatGPT work needs both workstation-wide agent guidance and repository-specific guidance. `project.select` is the point where local-dev resolves that instruction stack for the selected project and optional worktree.

local-dev does not parse or interpret the instructions. It reads the applicable files, returns their content and source metadata, and leaves execution policy to the calling agent.

## Resolution order

For an interactive `project.select`, local-dev resolves instructions in this order:

1. global instructions from `$CODEX_HOME/AGENTS.md`,
2. project instructions from the selected working root.

`CODEX_HOME` defaults to `~/.haru/.codex` when the environment variable is unset or blank.

For a normal project root, the project source is:

```text
<project-root>/AGENTS.md
```

For a selected git worktree, local-dev checks:

```text
<working-root>/AGENTS.md
<project-root>/AGENTS.md
```

and uses the first existing project-level file. This lets a worktree override repository guidance without losing the global layer.

The effective content is composed as:

```text
$CODEX_HOME/AGENTS.md

<selected project/worktree AGENTS.md>
```

The later project/worktree instructions take precedence when instructions conflict.

## Returned shape

When at least one instruction source exists, `project.select` returns `agent_instructions` with the effective content and source metadata. Conceptually:

```json
{
  "agent_instructions": {
    "path": "AGENTS.md",
    "content": "<global instructions>\n\n<project instructions>\n",
    "truncated": false,
    "sources": [
      {
        "scope": "global",
        "path": "$CODEX_HOME/AGENTS.md",
        "truncated": false
      },
      {
        "scope": "project",
        "path": "AGENTS.md",
        "truncated": false
      }
    ]
  }
}
```

`path` remains the primary project/worktree instruction path when one exists, preserving compatibility with clients that previously treated `agent_instructions.path` as a single project file. If only the global file exists, it becomes the primary path. If neither source exists, `agent_instructions` is `null`.

Each source is read up to 64 KiB. `truncated` is true when any included source exceeded that limit, while each entry in `sources` reports truncation for that individual file.

## Scope and ownership

The global file is intentionally external to the local-dev repository. It is workstation/user policy, while repository `AGENTS.md` files remain project policy.

This separation allows a user to publish cross-project operational guidance into `$CODEX_HOME/AGENTS.md` without adding those user-specific rules to the public local-dev repository. For example, a workstation may require a particular local job queue for resource-heavy work. local-dev can surface that instruction without depending on, detecting, or implementing the external queue itself.

Accordingly:

- local-dev does not depend on Pueue or another local scheduler,
- `shell.run` remains a generic shell execution primitive,
- user/workstation guidance may require an external wrapper before invoking a heavy command,
- repository guidance can refine or override the global rule for that project when necessary.

## Interactive vs Scheduled Task behavior

This instruction resolution belongs to interactive project selection. Interactive chats have persistent per-chat project context, so `project.select` selects the project and returns the applicable instruction stack.

Scheduled Tasks are intentionally stateless because the observed Scheduled Task request shape does not provide a stable chat/session identity. Do not call `project.select` expecting persistence from a Scheduled Task. Pass `project_id` and optional `working_dir` on each project-scoped call instead.

See [`chatgpt-scheduled-task-mcp-metadata.md`](./chatgpt-scheduled-task-mcp-metadata.md) for the Scheduled Task context rules.

## ChatGPT refresh behavior

Changing `project.select` tool metadata or its public contract requires the normal four-layer refresh flow:

```text
repository source
    -> running MCP runtime
        -> workspace app action snapshot
            -> conversation / branch tool binding
```

After refreshing the runtime and workspace action snapshot, create a Branch chat or new chat. Then call `project.select` once and verify:

- `agent_instructions.sources` lists the expected global and project/worktree sources,
- the effective content includes the current global guidance,
- the selected project/worktree guidance is present after the global content,
- a worktree-local `AGENTS.md` is preferred over the repository root when applicable.

See [`chatgpt-business-app-schema-refresh.md`](./chatgpt-business-app-schema-refresh.md) for the current observed Workspace refresh procedure.

## Implementation and verification

Relevant implementation:

- `src/mcp/tools/project-select.ts`
- `src/mcp/tool-definitions.ts`
- `tests/unit/project-select.test.ts`

The focused unit tests cover project-only instructions, merged global + project instructions, worktree precedence, and the no-instructions case. Tool-contract changes should also pass typechecking, the production build, and the full test suite before runtime deployment.
