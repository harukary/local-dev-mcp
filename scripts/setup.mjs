#!/usr/bin/env node
// Local setup for this checkout. Optional modules default to ON and require no
// external runtime until their tools are used.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const features = {
  mobile: "LOCAL_DEV_MCP_FEATURE_MOBILE",
  computer: "LOCAL_DEV_MCP_FEATURE_COMPUTER",
  browser: "LOCAL_DEV_MCP_FEATURE_BROWSER",
  "repo-actions": "LOCAL_DEV_MCP_FEATURE_REPO_ACTIONS",
};
const featureNames = Object.keys(features);

function usage() {
  console.log(`Usage: pnpm run setup [--disable mobile,computer,browser,repo-actions] [--enable name,...]
                  [--project /absolute/path] [--id project-id] [--yes]

All four optional features are ON by default. Without flags, interactive terminals
can choose which to turn OFF. Existing .env entries and project registry are preserved
unless their optional-feature settings are explicitly changed.`);
}

function parseList(value) {
  const values = value === "none" || value === "" ? [] : value.split(",").map(x => x.trim()).filter(Boolean);
  const invalid = values.filter(x => !featureNames.includes(x));
  if (invalid.length) throw new Error(`Unknown optional feature: ${invalid.join(", ")}. Valid: ${featureNames.join(", ")}`);
  return [...new Set(values)];
}

function optionsFor(argv) {
  const options = { enable: [], disable: [], project: undefined, id: undefined, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag === "--help" || flag === "-h") { usage(); process.exit(0); }
    if (flag === "--yes") { options.yes = true; continue; }
    if (!["--disable", "--enable", "--project", "--id"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--disable" || flag === "--enable") options[flag.slice(2)] = parseList(value);
    else options[flag.slice(2)] = value;
  }
  if (options.disable.some(name => options.enable.includes(name))) throw new Error("A feature cannot be both enabled and disabled.");
  return options;
}

function existingFlags(text) {
  const settings = Object.fromEntries(featureNames.map(name => [name, true]));
  for (const name of featureNames) {
    const variable = features[name];
    const matches = [...text.matchAll(new RegExp(`^(?:export\\s+)?${variable}=(.*)$`, "gm"))];
    if (!matches.length) continue;
    const raw = matches.at(-1)[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (["0", "false", "off", "no"].includes(raw)) settings[name] = false;
    else if (!["1", "true", "on", "yes"].includes(raw)) throw new Error(`Invalid existing ${variable} setting.`);
  }
  return settings;
}

async function ask(prompt, current) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(`${prompt} [${current}]: `)).trim() || current; }
  finally { reader.close(); }
}

function atomicPrivateWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try { renameSync(temp, path); chmodSync(path, 0o600); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

async function main() {
  const flags = optionsFor(process.argv.slice(2));
  const cwd = process.cwd();
  const envPath = join(cwd, ".env");
  const projectRegistryPath = join(cwd, "config", "projects.local.yaml");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const settings = existingFlags(existing);
  const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY && !flags.yes);

  if (canPrompt && !flags.disable.length && !flags.enable.length) {
    console.log("Optional features: mobile, computer, browser, repo-actions (default: all ON)");
    const disabled = featureNames.filter(name => !settings[name]).join(",") || "none";
    const response = await ask("Disable features (comma separated)", disabled);
    const disabledNow = new Set(parseList(response));
    for (const name of featureNames) settings[name] = !disabledNow.has(name);
  } else {
    for (const name of flags.disable) settings[name] = false;
    for (const name of flags.enable) settings[name] = true;
  }

  if (!existsSync(projectRegistryPath)) {
    let projectPath = flags.project || cwd;
    if (canPrompt && !flags.project) projectPath = await ask("Project directory to register", projectPath);
    const projectRoot = realpathSync(resolve(projectPath));
    let projectId = flags.id || basename(projectRoot).replace(/[^A-Za-z0-9_.-]/g, "-");
    if (canPrompt && !flags.id) projectId = await ask("Project ID", projectId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(projectId)) throw new Error("Invalid project ID.");
    const sample = yaml.load(readFileSync(join(root, "config", "projects.yaml"), "utf8"));
    const example = sample.projects.example;
    const output = { projects: { [projectId]: { ...example, display_name: projectId, host_root: projectRoot, sandbox_root: projectRoot } } };
    mkdirSync(dirname(projectRegistryPath), { recursive: true });
    writeFileSync(projectRegistryPath, yaml.dump(output), { mode: 0o600, flag: "wx" });
    console.log(`Created config/projects.local.yaml (project: ${projectId}).`);
  } else {
    if (flags.project || flags.id) throw new Error("Project registry already exists; edit config/projects.local.yaml to change projects.");
    console.log("Preserved existing config/projects.local.yaml.");
  }

  const optionalLines = new Set(Object.values(features));
  const retained = existing.split(/\r?\n/).filter(line => {
    const key = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    return !key || !optionalLines.has(key);
  }).join("\n").trimEnd();
  const section = [
    "# Optional tools (1=ON, 0=OFF; default ON)",
    ...featureNames.map(name => `${features[name]}=${settings[name] ? "1" : "0"}`),
  ].join("\n");
  atomicPrivateWrite(envPath, `${retained ? retained + "\n\n" : ""}${section}\n`);
  console.log(`Saved .env: ${featureNames.map(name => `${name}=${settings[name] ? "ON" : "OFF"}`).join(", ")}`);
  console.log("Run 'pnpm run doctor' to verify the selected project and installed optional tools.");
}
main().catch(error => { console.error("Setup error:", error.message); process.exitCode = 1; });
