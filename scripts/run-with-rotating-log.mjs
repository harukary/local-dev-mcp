#!/usr/bin/env node

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

function parsePositiveInteger(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fallback;
  return parsed;
}

const separator = process.argv.indexOf("--");
if (separator < 0 || separator < 3 || separator === process.argv.length - 1) {
  console.error("usage: run-with-rotating-log.mjs <log-path> -- <command> [args...]");
  process.exit(64);
}

const logPath = process.argv[2];
const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
const maxBytes = parsePositiveInteger(process.env.LOCAL_DEV_MCP_LOG_MAX_BYTES, 10 * 1024 * 1024, 1024);
const keep = parsePositiveInteger(process.env.LOCAL_DEV_MCP_LOG_KEEP, 5, 1);
const tee = process.env.LOCAL_DEV_MCP_LOG_TEE === "1";

mkdirSync(dirname(logPath), { recursive: true });
let fd = openSync(logPath, "a", 0o600);
chmodSync(logPath, 0o600);
let currentSize = statSync(logPath).size;
let closed = false;
let spawnFailed = false;

function rotate() {
  closeSync(fd);

  const oldest = `${logPath}.${keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = keep - 1; index >= 1; index--) {
    const source = `${logPath}.${index}`;
    if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
  }
  if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);

  fd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  currentSize = 0;
}

function append(chunk, mirror) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;

  while (offset < buffer.length) {
    if (currentSize >= maxBytes) rotate();
    const available = maxBytes - currentSize;
    const end = Math.min(buffer.length, offset + available);
    const slice = buffer.subarray(offset, end);
    writeSync(fd, slice);
    currentSize += slice.length;
    offset = end;
  }

  if (tee) mirror.write(buffer);
}

const child = spawn(command, args, {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => append(chunk, process.stdout));
child.stderr.on("data", (chunk) => append(chunk, process.stderr));

function forwardSignal(signal) {
  if (!child.killed) child.kill(signal);
}
process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));

function closeLog() {
  if (closed) return;
  closed = true;
  closeSync(fd);
}

child.on("error", (error) => {
  spawnFailed = true;
  append(Buffer.from(`[log-supervisor] failed to start child: ${error.message}\n`), process.stderr);
});

child.on("close", (code, signal) => {
  closeLog();
  if (spawnFailed) {
    process.exitCode = 127;
  } else if (signal) {
    process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
