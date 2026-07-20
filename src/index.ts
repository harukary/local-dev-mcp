#!/usr/bin/env node
import { resolve } from "node:path";
import { loadEnvFileIfExists } from "./env.js";

const args = process.argv.slice(2);
const command = ["doctor", "help", "serve", "stdio"].includes(args[0] || "") ? args.shift() : undefined;
const envPath = readOptionValue(args, "--env") || resolve(".env");

loadEnvFileIfExists(envPath);

const httpIndex = args.indexOf("--http");
const port = httpIndex !== -1 ? parseInt(args[httpIndex + 1] || "3456", 10) : null;

const configPath = args.find((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (index > 0 && optionConsumesValue(args[index - 1])) return false;
  return true;
}) || resolve("config/projects.yaml");

if (command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "doctor") {
  const { runDoctor } = await import("./cli/doctor.js");
  const code = await runDoctor({ configPath, envPath });
  process.exit(code);
}

const { startMcpServer, startHttpServer } = await import("./mcp/server.js");
const httpPort = command === "serve" ? port || 3456 : port;

if (httpPort) {
  startHttpServer(configPath, httpPort).catch(exitWithFatalError);
} else {
  startMcpServer(configPath).catch(exitWithFatalError);
}

function readOptionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function optionConsumesValue(option: string): boolean {
  return option === "--http" || option === "--env";
}

function exitWithFatalError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Fatal error:", message);
  process.exit(1);
}

function printHelp(): void {
  console.log(`local-dev-mcp

Usage:
  local-dev-mcp [configPath]
  local-dev-mcp --http 3456 [configPath]
  local-dev-mcp serve [configPath]
  local-dev-mcp doctor [configPath]

Options:
  --env PATH     Load environment variables from PATH before startup. Defaults to .env.
  --http PORT   Start HTTP MCP server on 127.0.0.1:PORT.
`);
}
