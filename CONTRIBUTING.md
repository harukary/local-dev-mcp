# Contributing to local-dev-mcp

Contributions that improve reliability, security, documentation, and the everyday developer experience are welcome. This project controls a trusted development workstation, so changes to authorization, command execution, and file access require particular care.

## Before filing an issue

- Search existing GitHub issues and pull requests for the same problem.
- For a reproducible bug, describe what you expected, what happened instead, how to reproduce it with a non-sensitive example, and the relevant operating system, Node.js version, MCP client, and tool name.
- For an improvement, explain the workflow limitation and the smallest useful change.
- Remove credentials, local paths identifying people, user content, logs containing secrets, and unredacted request/response payloads.
- **Security vulnerabilities:** do not open a public issue or submit details through the MCP feedback tools. Follow [SECURITY.md](SECURITY.md) for private disclosure.

The `feedback.report` / `feedback.list` / `feedback.update` tools are for tracking problems **inside your own MCP server**. They do not create GitHub issues, notify maintainers, or sync across installations. See the [feedback guide](docs/feedback.md) for their intended use.

## Submit a pull request

1. Fork the repository and create a focused branch.
2. Install dependencies with `pnpm install` and review the example registry in `config/projects.yaml`; never commit `config/projects.local.yaml` or secrets.
3. Keep changes small and compatible with the project and client authorization boundaries. Add or adjust tests near the changed behavior.
4. Run the relevant checks:

   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   ```

5. Update `README.md`, `README_ja.md`, or the relevant `docs/` page when behavior or setup changes. For MCP tool contract changes, update the schema version and document how maintainers can refresh the existing ChatGPT App. Contributors do not need access to the maintainers' Workspace.
6. Open a pull request explaining the problem, solution, potential security impact, and which checks you ran.

Do not include personal runtime state, stored feedback, authentication files, browser profiles, logs, screenshots of private data, or generated build artifacts in a pull request.

## Licensing and third-party code

Unless otherwise indicated in a directory or file, contributions are submitted under the repository's [Apache License 2.0](LICENSE). Only submit material you have the right to license. Preserve third-party notices and file-specific licenses; `agentic-inbox/` retains its own [license](agentic-inbox/LICENSE) and upstream attribution.
