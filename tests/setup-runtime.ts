import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const runtime = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-mcp-tests-")));
process.env.LOCAL_DEV_MCP_JOB_STORE_DIR = join(runtime, "jobs");
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
