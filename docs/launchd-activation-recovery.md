# launchd activation recovery

## 2026-10-28 incident (Mini)

The HTTP server was healthy on port 3456, but the Business Tunnel was not loaded. The activation worker had stopped the existing services and restarted the server, then failed while bootstrapping the launchd-disabled Personal Tunnel. Its early exit prevented the subsequent Business Tunnel bootstrap. ChatGPT tool calls returned `Session terminated` during this outage; that message alone does not identify the failed layer.

Bootstrapping the existing Business LaunchAgent restored its health endpoint and a `local-dev-mini` `project.list` call from the same conversation. The server's MCP session handling did not need a change.

## Activation contract

- Before unloading services, read launchd's disabled-job policy and verify every requested LaunchAgent exists. If either inspection fails or a requested job is disabled/missing, stop with an explicit error and leave the running services untouched. Do not silently skip or enable a disabled job.
- After the server is healthy, attempt every requested Tunnel even if another Tunnel fails. Report the activated and failed jobs separately and exit nonzero on partial activation.
- On a Business-only host, explicitly select Business and exclude Personal:

  ```bash
  LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_ENABLE=0 LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE=1 pnpm launchd:activate
  ```

The install command hands off to a one-shot worker; successful handoff does not mean activation completed. Read `logs/launchd-activate.log` and `logs/launchd-activate-error.log`, verify the selected launchd jobs and their health endpoints, and execute a real ChatGPT tool call.
