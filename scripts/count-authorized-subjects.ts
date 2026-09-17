#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { countDistinctAuthorizedSubjects } from "../src/audit/subject-count.js";

const args = process.argv.slice(2);
const logs: string[] = [];
let since: string | undefined;
let until: string | undefined;

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === "--") continue;
  if (value === "--log") logs.push(requireValue(args, ++index, value));
  else if (value === "--since") since = requireValue(args, ++index, value);
  else if (value === "--until") until = requireValue(args, ++index, value);
  else if (value === "-h" || value === "--help") {
    console.log("usage: pnpm audit:subject-count -- --since <ISO> --until <ISO> [--log <path>]...");
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${value}`);
  }
}

if (!since || !until) throw new Error("--since and --until are required");
if (logs.length === 0) logs.push("logs/audit.jsonl");

const lines: string[] = [];
for (const path of logs) {
  const content = await readFile(path, "utf8");
  lines.push(...content.split("\n"));
}

const result = countDistinctAuthorizedSubjects(lines, { since, until });
console.log(`window: ${result.since} <= timestamp < ${result.until}`);
console.log(`distinct authorized subjects: ${result.distinctAuthorizedSubjects}`);
console.log(`authorized audit records: ${result.matchedRecords}`);

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
