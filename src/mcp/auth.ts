import type { IncomingMessage, ServerResponse } from "node:http";

export const ENV_KEY = "LOCAL_DEV_MCP_API_KEY";

export function loadApiKey(): string | null {
  const key = process.env[ENV_KEY];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function requireAuth(
  apiKey: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!apiKey) {
    return true;
  }

  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    sendUnauthorized(res);
    return false;
  }

  const token = auth.slice(7);
  if (token !== apiKey) {
    sendUnauthorized(res);
    return false;
  }

  return true;
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": 'Bearer realm="local-dev-mcp"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized", message: "A valid API key is required." }));
}
