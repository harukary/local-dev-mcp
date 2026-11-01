# Muse VM client for local-dev MCP

This is the minimal CLI for a reusable custom integration on Meta Muse's Secure VM.
It is **not Muse Code** and does not require a public MCP connector.

## Requirements

- Muse Tailscale connector is joined to the same tailnet as the development Mac.
- The local-dev MCP server is reachable over a tailnet-only Tailscale Serve HTTPS endpoint.
- Python 3 is available in the Muse VM.
- `HTTPS_PROXY` is provided by Muse at runtime (the client targets the same proxy host at port 3130).
- The connector's secure credential injection supplies `LOCAL_DEV_MCP_MUSE_TOKEN` at process execution time. Do not paste this token into a chat, embed it in code, or write it to a plaintext Skill.

The client fails closed if any required value is absent. Muse's documented secure credential surrogation exists, but whether arbitrary custom CLI environment injection is available must be established during setup. Do not work around this by moving credentials into the Muse workspace.

## Use

Set the non-secret `LOCAL_DEV_MCP_URL` to `https://<mac-tailnet-fqdn>:10000/mcp`. With the secure token injection configured:

```sh
python3 client.py projects
python3 client.py tools --filter workspace.
python3 client.py schema workspace.read
python3 client.py call project.open '{"project_id":"local-dev-mcp"}'
python3 client.py call workspace.read '{"project_id":"local-dev-mcp","path":"README.md"}'
```

The client creates a new HTTPS CONNECT request via Muse's port 3130 proxy on every invocation. It initializes MCP, calls one operation, and returns text without duplicating structured JSON. The proxy password can change between shell sessions, so never cache it in a long-running process.

Every project-scoped call must include `project_id`. For worktrees, pass `working_dir` consistently to operations and async shell.status/cancel. Do not rely on previous project selection. Follow instructions returned by `project.open`.

Only the development Mac's exact .ts.net URL is accepted. Keep Tailscale Serve on a dedicated port, keep Funnel disabled, and preserve the existing ChatGPT and Claude paths. Do not turn off local-dev authorization or bypass the Muse TCP proxy when connection fails.

Non-text MCP blocks are not rendered by this CLI; use text-oriented operations until media support is explicitly verified on Muse.
