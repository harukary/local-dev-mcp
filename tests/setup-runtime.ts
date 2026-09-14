import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

const root = join(process.env.HARUCLAW_WORKSPACE_DIR ?? resolve(process.cwd(), ".."), "generated", "local-dev-mcp-tests");
mkdirSync(root, { recursive: true });
const runtime = mkdtempSync(join(root, "runtime-"));
process.env.LOCAL_DEV_MCP_JOB_STORE_DIR = join(runtime, "jobs");
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
