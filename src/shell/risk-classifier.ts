import type { RiskLevel } from "../types.js";

interface RiskRule {
  pattern: RegExp;
  level: RiskLevel;
  reason: string;
}

const FORBIDDEN_PATTERNS: RiskRule[] = [
  { pattern: /\bsudo\b/, level: "forbidden", reason: "sudo command" },
  { pattern: /\bsu\b/, level: "forbidden", reason: "su command" },
  { pattern: /printenv/, level: "forbidden", reason: "printenv exposes all environment variables" },
  { pattern: /^env\s*$/, level: "forbidden", reason: "env exposes all environment variables" },
  { pattern: /^env\s*\|/, level: "forbidden", reason: "env exposes all environment variables" },
  { pattern: /cat\s+(~\/)?\.ssh\//, level: "forbidden", reason: "reads SSH private key" },
  { pattern: /cat\s+\.env/, level: "forbidden", reason: "reads .env file" },
  { pattern: /cat\s+(~\/)?\.env/, level: "forbidden", reason: "reads .env file" },
  { pattern: /\b(head|less|more|tail|sed|awk)\s+.*\.env/, level: "forbidden", reason: "reads .env file via pager/stream" },
  { pattern: /\b(head|less|more|tail)\s+.*\.ssh\//, level: "forbidden", reason: "reads SSH key via pager/stream" },
  { pattern: /\bcat\b.*\b\.ssh\/(id_|known_hosts|authorized_keys|config)/, level: "forbidden", reason: "reads SSH files" },
  { pattern: /curl.*-d\s+@\.env/, level: "forbidden", reason: "exfiltrates .env via curl" },
  { pattern: /\bchmod\s+-R\s+777\s+\//, level: "forbidden", reason: "makes entire filesystem world-writable" },
  { pattern: /\brm\s+-rf\s+\/\s*$/, level: "forbidden", reason: "deletes entire filesystem" },
  { pattern: /\beval\b/, level: "forbidden", reason: "eval allows arbitrary indirect execution" },
  { pattern: /base64\s+-d\s*\|/, level: "forbidden", reason: "base64 decode pipe bypasses classifier" },
  { pattern: /\|\s*bash\b/, level: "forbidden", reason: "pipe to bash bypasses classifier" },
  { pattern: /\|\s*sh\b/, level: "forbidden", reason: "pipe to sh bypasses classifier" },
  { pattern: /\bdeclare\s+-[a-z]/i, level: "forbidden", reason: "declare variable injection" },
  { pattern: /\balias\b/, level: "forbidden", reason: "alias can override commands" },
];

const CATASTROPHIC_PATTERNS: RiskRule[] = [
  { pattern: /\brm\s+-rf\s+\/\s*$/, level: "forbidden", reason: "deletes entire filesystem" },
  { pattern: /\bchmod\s+-R\s+777\s+\//, level: "forbidden", reason: "makes entire filesystem world-writable" },
  { pattern: /\bmkfs(?:\.\w+)?\b/, level: "forbidden", reason: "formats a filesystem" },
  { pattern: /\bdd\b.*\bof=\/dev\//, level: "forbidden", reason: "writes raw data to a device" },
  { pattern: /\bdiskutil\s+(erase|partition|apfs\s+delete|apfs\s+erase)/i, level: "forbidden", reason: "destructive disk operation" },
  { pattern: /\b(shutdown|reboot|halt)\b/, level: "forbidden", reason: "system power control" },
];

const DESTRUCTIVE_PATTERNS: RiskRule[] = [
  { pattern: /\brm\s+-rf\b/, level: "destructive_or_process_control", reason: "recursive force delete" },
  { pattern: /\bginit\s+clean\s+-fd\b|\bgit\s+clean\s+-fd\b/, level: "destructive_or_process_control", reason: "force clean git ignored files" },
  { pattern: /\bkill\s+/, level: "destructive_or_process_control", reason: "process kill" },
  { pattern: /\bpkill\b/, level: "destructive_or_process_control", reason: "process kill by name" },
  { pattern: /\bdocker\s+rm\b/, level: "destructive_or_process_control", reason: "docker container removal" },
  { pattern: /\btmux\s+send-keys\b/, level: "destructive_or_process_control", reason: "tmux send-keys bypasses sandbox" },
];

const NETWORK_PATTERNS: RiskRule[] = [
  { pattern: /\bnpm\s+install\b/, level: "network_or_dependency", reason: "npm install accesses registry" },
  { pattern: /\bpnpm\s+add\b/, level: "network_or_dependency", reason: "pnpm add accesses registry" },
  { pattern: /\bpnpm\s+install\b/, level: "network_or_dependency", reason: "pnpm install accesses registry" },
  { pattern: /\byarn\s+add\b/, level: "network_or_dependency", reason: "yarn add accesses registry" },
  { pattern: /\byarn\s+install\b/, level: "network_or_dependency", reason: "yarn install accesses registry" },
  { pattern: /\bpip\s+install\b/, level: "network_or_dependency", reason: "pip install accesses PyPI" },
  { pattern: /\bcargo\s+add\b/, level: "network_or_dependency", reason: "cargo add accesses crates.io" },
  { pattern: /\bgo\s+get\b/, level: "network_or_dependency", reason: "go get accesses remote module" },
  { pattern: /\bcurl\b/, level: "network_or_dependency", reason: "curl makes network request" },
  { pattern: /\bwget\b/, level: "network_or_dependency", reason: "wget makes network request" },
  { pattern: /\bginit\s+clone\b|\bgit\s+clone\b/, level: "network_or_dependency", reason: "git clone accesses remote repository" },
];

const WRITE_PATTERNS: RiskRule[] = [
  { pattern: /\bsed\s+-i\b/, level: "workspace_write", reason: "sed in-place edit" },
  { pattern: /\bginit\s+apply\b|\bgit\s+apply\b/, level: "workspace_write", reason: "git apply modifies files" },
  { pattern: /\bginit\s+add\b|\bgit\s+add\b/, level: "workspace_write", reason: "git add stages files" },
  { pattern: /\bginit\s+commit\b|\bgit\s+commit\b/, level: "workspace_write", reason: "git commit creates snapshot" },
  { pattern: /\bginit\s+checkout\b|\bgit\s+checkout\b/, level: "workspace_write", reason: "git checkout can lose changes" },
  { pattern: /\bginit\s+revert\b|\bgit\s+revert\b/, level: "workspace_write", reason: "git revert modifies history" },
  { pattern: /\bginit\s+reset\b|\bgit\s+reset\b/, level: "workspace_write", reason: "git reset can lose changes" },
  { pattern: /\bnpm\s+run\s+\w*format\w*/, level: "workspace_write", reason: "formatter modifies files" },
  { pattern: /\bpython\b/, level: "workspace_write", reason: "arbitrary Python script execution" },
  { pattern: /\bnode\b/, level: "workspace_write", reason: "arbitrary Node.js script execution" },
  { pattern: /\btsx\b/, level: "workspace_write", reason: "arbitrary TypeScript execution" },
  { pattern: /\bmv\b/, level: "workspace_write", reason: "move/rename files" },
  { pattern: /\bcp\b/, level: "workspace_write", reason: "copy files" },
  { pattern: /\bmkdir\b/, level: "workspace_write", reason: "create directories" },
  { pattern: /\btouch\b/, level: "workspace_write", reason: "create files" },
  { pattern: /\b>>\b/, level: "workspace_write", reason: "shell append redirect" },
  { pattern: /\b>\s+\S/, level: "workspace_write", reason: "shell output redirect" },
];

const COMPUTE_PATTERNS: RiskRule[] = [
  { pattern: /\bnpm\s+test\b/, level: "local_compute", reason: "npm test" },
  { pattern: /\bnpm\s+run\s+(?!\w*format)/, level: "local_compute", reason: "npm script" },
  { pattern: /\bpytest\b/, level: "local_compute", reason: "pytest" },
  { pattern: /\bvitest\b/, level: "local_compute", reason: "vitest" },
  { pattern: /\bcargo\s+test\b/, level: "local_compute", reason: "cargo test" },
  { pattern: /\bcargo\s+check\b/, level: "local_compute", reason: "cargo check" },
  { pattern: /\bcargo\s+build\b/, level: "local_compute", reason: "cargo build" },
  { pattern: /\bgo\s+test\b/, level: "local_compute", reason: "go test" },
  { pattern: /\bgo\s+build\b/, level: "local_compute", reason: "go build" },
  { pattern: /\bmake\b/, level: "local_compute", reason: "make" },
  { pattern: /\bdeno\s+test\b/, level: "local_compute", reason: "deno test" },
  { pattern: /\bdeno\s+check\b/, level: "local_compute", reason: "deno check" },
  { pattern: /\bturbo\s+run\b/, level: "local_compute", reason: "turbo run" },
  { pattern: /\btc\s+--noEmit\b/, level: "local_compute", reason: "tsc typecheck" },
  { pattern: /\btypecheck\b/, level: "local_compute", reason: "typecheck script" },
  { pattern: /\blint\b/, level: "local_compute", reason: "linter" },
];

export function classifyRisk(command: string, deniedPaths?: string[]): { level: RiskLevel; reasons: string[] } {
  const trimmed = command.trim();

  if (deniedPaths?.length) {
    const denied = checkDeniedPaths(trimmed, deniedPaths);
    if (denied) {
      return { level: "forbidden", reasons: [denied] };
    }
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { level: "forbidden", reasons: [rule.reason] };
    }
  }

  for (const rule of DESTRUCTIVE_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { level: "destructive_or_process_control", reasons: [rule.reason] };
    }
  }

  for (const rule of NETWORK_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { level: "network_or_dependency", reasons: [rule.reason] };
    }
  }

  for (const rule of WRITE_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { level: "workspace_write", reasons: [rule.reason] };
    }
  }

  for (const rule of COMPUTE_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { level: "local_compute", reasons: [rule.reason] };
    }
  }

  return { level: "read_only", reasons: ["default: read-only"] };
}

export function isCatastrophicCommand(command: string): boolean {
  const trimmed = command.trim();
  return CATASTROPHIC_PATTERNS.some((rule) => rule.pattern.test(trimmed));
}

function checkDeniedPaths(command: string, deniedPaths: string[]): string | null {
  const pathCandidates = extractPathCandidates(command);
  for (const pattern of deniedPaths) {
    const regex = patternToRegex(pattern);
    if (regex.test(command)) {
      return `command accesses denied path: ${pattern}`;
    }
    for (const candidate of pathCandidates) {
      if (matchesDeniedPath(regex, candidate)) {
        return `command accesses denied path: ${pattern}`;
      }
    }
  }
  return null;
}

function extractPathCandidates(command: string): string[] {
  const tokens = command.split(/\s+/);
  const candidates = new Set<string>();

  for (const token of tokens) {
    const cleaned = token.replace(/^[\s"'`<>{}\[\](),;:!?]+|[\s"'`<>{}\[\](),;:!?]+$/g, "");
    if (!cleaned) continue;

    const parts = [cleaned];
    const equalsIndex = cleaned.lastIndexOf("=");
    if (equalsIndex > 0 && equalsIndex < cleaned.length - 1) {
      parts.push(cleaned.slice(equalsIndex + 1));
    }

    for (const part of parts) {
      if (!looksLikePathReference(part)) continue;
      candidates.add(part);
    }
  }

  return Array.from(candidates);
}

function looksLikePathReference(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith(".") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("/")
  );
}

function matchesDeniedPath(regex: RegExp, candidate: string): boolean {
  for (const suffix of pathSuffixes(candidate)) {
    if (regex.test(suffix)) {
      return true;
    }
  }
  return false;
}

function pathSuffixes(candidate: string): string[] {
  const normalized = candidate.replace(/^[~]/, "").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  const suffixes = new Set<string>([candidate, normalized]);

  for (let i = 0; i < segments.length; i++) {
    suffixes.add(segments.slice(i).join("/"));
  }

  return Array.from(suffixes).filter(Boolean);
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  return new RegExp(`(?<![\\w/])${escaped}(?![\\w/])`, "i");
}
