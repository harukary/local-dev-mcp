# Feedback and continuous improvement

`local-dev-mcp` exposes three MCP tools to record recurring problems and improvement ideas that are not visible in `tool.usage` metrics. Reports stay on the MCP server you operate. They are **not** GitHub issues, are not sent to the repository maintainers, and are not synchronized across hosts.

## When to report

Report reproducible defects, missing capabilities, misleading tool descriptions, or recurring inefficient workflows. Do not create reports for one-off network failures that resolve through a normal retry.

Do not include credentials, real user content, full conversations, browser HTML, or raw tool requests/responses. The server masks some common secret patterns as a precaution, not as a guarantee.

## Report a problem

Call `feedback.report` with an MCP argument object such as this **illustrative** example:

```json
{
  "kind": "bug",
  "title": "Large batch results are unexpectedly truncated",
  "description": "A multi-file read returned incomplete content without an actionable explanation. Expected an explicit truncation notice.",
  "impact": "Repeated reads are needed to complete the operation.",
  "related_tool": "workspace.batch",
  "suggestion": "Identify which result exceeded the limit."
}
```

`kind` accepts `bug`, `improvement`, or `missing_feature`. `title` and `description` are required; `impact`, `related_tool`, `suggestion`, and `project_id` are optional.

No selected project is required. In ChatGPT, a selected project is used when available. Claude can optionally pass `context_id` to associate the report with a work context; Muse can pass `project_id` explicitly. Without an associated project, the report describes a server-wide issue.

Reports with the same project, kind, related tool, and normalized title count toward one record. The response includes `id`, `occurrences`, and `created`. To report a known recurrence, pass its `existing_id` to `feedback.report`; if the issue was closed, it reopens and its `reopened` counter increases.

## List and resolve reports

The following JSON objects are **MCP tool arguments**, not shell commands.

Call `feedback.list` with:

```json
{"status":"active","limit":50}
```

The default `active` filter includes `open` and `in_progress` reports across all projects. For recently changed reports, including closed ones:

```json
{"status":"all","recent_days":7,"limit":100}
```

Use `project_id` or `kind` to narrow the results. If `has_more` is true, repeat the call with `offset` set to the returned `next_offset`. Each response includes `total` and up to 100 items.

Update an item after investigation:

```json
{"id":"fb_12345678-1234-4123-8123-123456789abc","status":"in_progress","note":"Reproduced with the current server build."}
```

After verifying a fix, call `feedback.update` with `status: "resolved"` and a nonempty `resolution`. To close a report that needs no change, use `status: "dismissed"` with the reason in `resolution`. The latest note and resolution are retained, but this store is **not** a complete event history.

## Weekly review

Use this process manually, or copy the following instruction into a ChatGPT Scheduled Task connected to your own MCP App. No scheduled job is created by installing this repository.

> Every week, use `tool.usage` with `recent_days=7` to review call volume, failures, partial failures, and latency. Use `feedback.list` with `status=active,limit=100` to retrieve every unresolved issue, paging through `next_offset` if needed. Also call `feedback.list` with `status=all,recent_days=7,limit=100` to review new, reopened, and recently resolved items. Compare reports with usage evidence, distinguish observations from verified bugs, and recommend the top one to three improvements by impact, frequency, recurrence, and effort. Mention when there are no new reports. Do not change code or feedback statuses as part of this review.

Scheduled Tasks require a supported ChatGPT account, a connected App, and access to the relevant tools. Running the review manually works with any supported MCP client.

## Storage, privacy, and limits

- Records are stored at `~/.local-dev-mcp/runtime/feedback.json` on the MCP host, outside Git. The file is created on the first report and uses restrictive directory/file permissions (0700/0600).
- Reports from ChatGPT, Claude, and Muse connected to the **same server** share one store. A second host such as `local-dev-mini` keeps a separate store; code synchronization does not synchronize feedback.
- The server records client type, relevant project when known, timestamps, status, occurrence and reopen counts. It does not automatically capture tool arguments, complete results, or conversation transcripts.
- Writes are serialized and saved through atomic file replacement. Corrupt data causes an explicit load error rather than silent reset. The store holds at most 5,000 reports.
- Treat stored reports as sensitive operational metadata. Redaction of common credential patterns is best-effort; review the content before submitting it.

For suggestions meant for **all users** of this project, use GitHub issues and pull requests as described in [CONTRIBUTING.md](../CONTRIBUTING.md). For suspected vulnerabilities, use private reporting as described in [SECURITY.md](../SECURITY.md).
