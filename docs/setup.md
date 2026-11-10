# Setup

local-dev-mcp is a self-hosted MCP server for trusted development machines. Mobile, Computer, Browser, and Repository Actions are optional; the core tools can operate without their external automation programs.

## 1. Install

Install Node.js 22+, pnpm, and Git.

```bash
git clone https://github.com/harukary/local-dev-mcp.git
cd local-dev-mcp
pnpm install
pnpm run setup
pnpm run doctor
```

`pnpm run setup` selects a project directory/ID and optional capabilities. **All four default to ON.** OFF means the tools disappear from the MCP schema and stale calls are rejected.

| Feature | Tools | External setup if used |
| --- | --- | --- |
| Browser | `browser.*` | Google Chrome |
| Computer | `computer.*` | macOS and [Cua Driver](computer-automation.md) |
| Mobile | `mobile.*` | [Device-specific tooling](mobile-automation.md) |
| Repository Actions | `repo.action.*` | A per-repository `.local-dev/actions.json` manifest |

There is no need to uninstall the CLI dependencies when disabling a feature. No additional MCP server is required.

For non-interactive setup or later changes:

```bash
pnpm run setup --yes
pnpm run setup --yes --disable mobile,computer
pnpm run setup --yes --enable computer
```

Unspecified feature flags keep their prior values. On first setup, `--project /absolute/path --id my-project` registers a different project. Add further projects in `config/projects.local.yaml`.

- `.env` holds feature flags without overwriting other variables or secrets; it is Git-ignored.
- `config/projects.local.yaml` defines authorized projects and write policies; it is created only when absent.

By default the checkout itself is the registered project. Register the intended development directory before operating on other projects. Restart the MCP server after changing feature flags. When using ChatGPT, refresh the actions on the existing App if the tool schema changed.

## 2. Connect

For a local stdio MCP client:

```bash
pnpm dev
```

For ChatGPT, use OpenAI Secure MCP Tunnel:

1. Create a Tunnel in OpenAI Platform and store its identifiers, runtime API key, and local token in private files; see [Tunnel configuration](../README.md#openai-secure-mcp-tunnel).
2. Run `pnpm tunnel:install` to install the official client.
3. Run `pnpm launchd:install` then `pnpm launchd:activate` to start the macOS services. For Business-only deployment, set `LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_ENABLE=0 LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE=1` for both commands.
4. Verify with `pnpm tunnel:doctor` and connect the Tunnel through ChatGPT Developer Mode.

Optional clients: [Claude](claude-cloudflare-access.md), [Muse](muse-tailscale-mcp.md).

## 3. Enable the tools you need

Setting a feature to ON does not install third-party CLIs or grant OS permissions. Follow the relevant guide only when using that capability:

- [Computer](computer-automation.md): install Cua Driver and grant macOS permissions
- [Mobile](mobile-automation.md): configure the required iOS / Android tools
- [Browser](browser-runtime.md): install Chrome and configure the isolated profile
- [Repository Actions](repo-actions.md): declare allowed actions for individual repositories

`pnpm run doctor` skips dependency checks for disabled capabilities. A missing optional CLI affects that tool family, not core project, workspace, and Git operations.
