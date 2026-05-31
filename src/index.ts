#!/usr/bin/env node
import { resolve } from "node:path";
import { startMcpServer, startHttpServer } from "./mcp/server.js";

const args = process.argv.slice(2);

const httpIndex = args.indexOf("--http");
const port = httpIndex !== -1 ? parseInt(args[httpIndex + 1] || "3456", 10) : null;

const configPath = args.find((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (index > 0 && args[index - 1] === "--http") return false;
  return true;
}) || resolve("config/projects.yaml");

if (port) {
  startHttpServer(configPath, port).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fatal error:", message);
    process.exit(1);
  });
} else {
  startMcpServer(configPath).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fatal error:", message);
    process.exit(1);
  });
}
