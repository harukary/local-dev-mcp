import { existsSync, readFileSync } from "node:fs";

export interface EnvLoadResult {
  path: string;
  loaded: boolean;
  keys: string[];
}

export function loadEnvFileIfExists(path = ".env"): EnvLoadResult {
  if (!existsSync(path)) {
    return { path, loaded: false, keys: [] };
  }

  const keys: string[] = [];
  const content = readFileSync(path, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = parseEnvValue(rawValue);
    keys.push(key);
  }

  return { path, loaded: true, keys };
}

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
