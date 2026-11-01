# Muse VM client for local-dev MCP

This is the small, stateless Python MCP client for Meta Muse's Secure VM, using a private Tailscale Serve endpoint. It is not Muse Code and does not require a public custom MCP server.

## Connection

- Muse and the Mac must be on the same Tailscale tailnet.
- Set `LOCAL_DEV_MCP_URL=https://<mac-tailnet-fqdn>:10000/mcp`.
- Keep Muse's runtime-provided `HTTPS_PROXY`; the client uses the same proxy host and credentials at TCP port 3130.
- Inject `LOCAL_DEV_MCP_MUSE_TOKEN` securely at execution time. Never paste the token into chat, embed it into a Skill or code, or save it in a plaintext workspace file.
- Python 3 with only the standard library is required.

The script performs MCP initialization and one tool operation per invocation. It does not cache runtime proxy credentials.

## Commands

```sh
python3 client.py projects
python3 client.py tools --filter workspace.
python3 client.py schema workspace.read
python3 client.py call project.open '{"project_id":"local-dev-mcp"}'
python3 client.py call workspace.read '{"project_id":"local-dev-mcp","path":"README.md"}'
python3 client.py call workspace.batch '{"project_id":"local-dev-mcp","requests":[{"tool":"workspace.read","arguments":{"path":"README.md"}},{"tool":"workspace.list","arguments":{}}]}'
```

Start with `project.list` and `project.open` to read instructions. Supply `project_id` on every project-scoped call and `working_dir` for worktrees. Do not use Claude's `context_id`. A stable internal Muse work identity isolates browser profiles and asynchronous shell jobs by project and working directory.

Muse-only policy hides and **rejects** direct calls to `project.select/current/reload`, `shell.approve/reject/pending`, and `artifact.link/receive`. Project denied paths and other policies remain enforced. Do not run concurrent stateful browser workflows within one work scope.

## Download inline images and files

MCP `image.read` returns an image block and `artifact.read` returns an embedded resource. Use `--output` to save the inline data locally:

```sh
python3 client.py call image.read '{"project_id":"local-dev-mcp","path":"docs/local-dev-mcp-system-overview-ja.png","mode":"preview"}' --output /path/to/new-preview.png
python3 client.py call artifact.read '{"project_id":"local-dev-mcp","path":"README.md"}' --output /path/to/new-readme.md
```

The output path must not exist; files are created with mode 0600. Symlink targets and existing files are never overwritten. The binary transfer limit is 6 MiB, and base64 is validated. Base64 media is never printed to stdout. Without `--output`, a media result produces a clear error rather than pretending the bytes were displayed.

Saving the image does not make it visible to Muse's model: open the saved file with an image-viewing capability available in Muse if visual inspection is required. `resource_link` results are not supported by this client. `image.read` with `mode=metadata` returns no bytes to save.

## Validation

```sh
python3 -m unittest discover -s integrations/muse -p 'test_*.py'
```

For server setup, HTTP authentication, Tailscale ACLs, and MCP profile details, see [docs/muse-tailscale-mcp.md](../../docs/muse-tailscale-mcp.md). Update the copy of this script inside Muse when the public repository changes. Never copy the Mac's secret token file into the Git repository.
