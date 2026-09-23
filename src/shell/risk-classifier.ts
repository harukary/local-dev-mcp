import type { RiskLevel } from "../types.js";

interface RiskRule {
  pattern: RegExp;
  level: RiskLevel;
  reason: string;
  scan?: "shell" | "raw";
}

const FORBIDDEN_PATTERNS: RiskRule[] = [
  { pattern: /\bsudo\b/, level: "forbidden", reason: "sudo command" },
  { pattern: /\bsu\b/, level: "forbidden", reason: "su command" },
  { pattern: /printenv/, level: "forbidden", reason: "printenv exposes all environment variables" },
  { pattern: /^env\s*$/, level: "forbidden", reason: "env exposes all environment variables" },
  { pattern: /^env\s*\|/, level: "forbidden", reason: "env exposes all environment variables" },
  { pattern: /cat\s+(~\/)?\.ssh\//, level: "forbidden", reason: "reads SSH private key", scan: "raw" },
  { pattern: /cat\s+\.env/, level: "forbidden", reason: "reads .env file", scan: "raw" },
  { pattern: /cat\s+(~\/)?\.env/, level: "forbidden", reason: "reads .env file", scan: "raw" },
  { pattern: /\b(head|less|more|tail|sed|awk)\s+.*\.env/, level: "forbidden", reason: "reads .env file via pager/stream", scan: "raw" },
  { pattern: /\b(head|less|more|tail)\s+.*\.ssh\//, level: "forbidden", reason: "reads SSH key via pager/stream", scan: "raw" },
  { pattern: /\bcat\b.*\b\.ssh\/(id_|known_hosts|authorized_keys|config)/, level: "forbidden", reason: "reads SSH files", scan: "raw" },
  { pattern: /curl.*-d\s+@\.env/, level: "forbidden", reason: "exfiltrates .env via curl", scan: "raw" },
  { pattern: /\bchmod\s+-R\s+777\s+\//, level: "forbidden", reason: "makes entire filesystem world-writable" },
  { pattern: /\brm\s+-rf\s+\/\s*$/, level: "forbidden", reason: "deletes entire filesystem" },
  { pattern: /base64\s+-d\s*\|/, level: "forbidden", reason: "base64 decode pipe bypasses classifier" },
  { pattern: /\|\s*bash\b/, level: "forbidden", reason: "pipe to bash bypasses classifier" },
  { pattern: /\|\s*sh\b/, level: "forbidden", reason: "pipe to sh bypasses classifier" },
  { pattern: /\b(?:bash|sh|zsh)\s+-c\b/, level: "forbidden", reason: "nested shell command bypasses classifier" },
  { pattern: /\b(?:bash|sh|zsh)\s+<<-?\s*/, level: "forbidden", reason: "nested shell heredoc bypasses classifier" },
  { pattern: /\bdeclare\s+-[a-z]/i, level: "forbidden", reason: "declare variable injection" },
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
  { pattern: /\bginit\s+push\b|\bgit\s+push\b/, level: "network_or_dependency", reason: "git push accesses remote repository" },
  { pattern: /\bginit\s+fetch\b|\bgit\s+fetch\b/, level: "network_or_dependency", reason: "git fetch accesses remote repository" },
  { pattern: /\bginit\s+pull\b|\bgit\s+pull\b/, level: "network_or_dependency", reason: "git pull accesses remote repository" },
  { pattern: /\bginit\s+ls-remote\b|\bgit\s+ls-remote\b/, level: "network_or_dependency", reason: "git ls-remote accesses remote repository" },
];

const WRITE_PATTERNS: RiskRule[] = [
  { pattern: /\bsed\s+-i\b/, level: "workspace_write", reason: "sed in-place edit" },
  { pattern: /\bchmod\b/, level: "workspace_write", reason: "chmod modifies file permissions" },
  { pattern: /\btee\b/, level: "workspace_write", reason: "tee writes file output" },
  { pattern: /\bginit\s+apply\b|\bgit\s+apply\b/, level: "workspace_write", reason: "git apply modifies files" },
  { pattern: /\bginit\s+add\b|\bgit\s+add\b/, level: "workspace_write", reason: "git add stages files" },
  { pattern: /\bginit\s+commit\b|\bgit\s+commit\b/, level: "workspace_write", reason: "git commit creates snapshot" },
  { pattern: /\bginit\s+checkout\b|\bgit\s+checkout\b/, level: "workspace_write", reason: "git checkout can lose changes" },
  { pattern: /\bginit\s+revert\b|\bgit\s+revert\b/, level: "workspace_write", reason: "git revert modifies history" },
  { pattern: /\bginit\s+reset\b|\bgit\s+reset\b/, level: "workspace_write", reason: "git reset can lose changes" },
  { pattern: /\bnpm\s+run\s+\w*format\w*/, level: "workspace_write", reason: "formatter modifies files" },
  { pattern: /\bpython(?:\d+(?:\.\d+)*)?\b/, level: "workspace_write", reason: "arbitrary Python script execution" },
  { pattern: /\bnode\b/, level: "workspace_write", reason: "arbitrary Node.js script execution" },
  { pattern: /\btsx\b/, level: "workspace_write", reason: "arbitrary TypeScript execution" },
  { pattern: /\bsqlite3\b(?:[^"\n]*"\s*|[^'"\n]*'\s*)(?:BEGIN\s*;\s*)?(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b/i, level: "workspace_write", reason: "SQLite mutation", scan: "raw" },
  { pattern: /\bmv\b/, level: "workspace_write", reason: "move/rename files" },
  { pattern: /\bcp\b/, level: "workspace_write", reason: "copy files" },
  { pattern: /\bmkdir\b/, level: "workspace_write", reason: "create directories" },
  { pattern: /\btouch\b/, level: "workspace_write", reason: "create files" },
  { pattern: /(^|[\s;&|])\d*>>(?![ \t]*\/dev\/null(?=$|[\s;&|]))[ \t]*(?!&)\S+/, level: "workspace_write", reason: "shell append redirect" },
  { pattern: /(^|[\s;&|])\d*>(?![>&])(?![ \t]*\/dev\/null(?=$|[\s;&|]))[ \t]*\S+/, level: "workspace_write", reason: "shell output redirect" },
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

function maskHereDocBodies(command: string): string {
  const lines = command.split("\n");
  const result: string[] = [];
  let delimiter: string | null = null;
  let stripTabs = false;

  for (const line of lines) {
    if (delimiter) {
      const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate.trimEnd() === delimiter) {
        result.push(line);
        delimiter = null;
        stripTabs = false;
      } else {
        result.push(" ".repeat(line.length));
      }
      continue;
    }

    result.push(line);
    const match = line.match(/<<(-)?\s*(['"]?)([A-Za-z0-9_]+)\2/);
    if (match) {
      stripTabs = Boolean(match[1]);
      delimiter = match[3];
    }
  }

  return result.join("\n");
}

function maskQuotedLiterals(command: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let result = "";
  for (const char of command) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        result += " ";
        continue;
      }
      if (quote === '"' && char === "\\") {
        escaped = true;
        result += " ";
        continue;
      }
      if (char === quote) quote = null;
      result += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

export function classifyRisk(command: string, deniedPaths?: string[]): { level: RiskLevel; reasons: string[] } {
  const trimmed = command.trim();
  const shellStructure = maskQuotedLiterals(maskHereDocBodies(trimmed));

  if (deniedPaths?.length) {
    const denied = checkDeniedPaths(trimmed, deniedPaths);
    if (denied) {
      return { level: "forbidden", reasons: [denied] };
    }
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    const target = rule.scan === "raw" ? trimmed : shellStructure;
    if (rule.pattern.test(target)) {
      return { level: "forbidden", reasons: [rule.reason] };
    }
  }

  if (containsShellCommandInvocation(shellStructure, "eval")) {
    return { level: "forbidden", reasons: ["eval allows arbitrary indirect execution"] };
  }

  if (/(?:^|[;&|]\s*)alias(?:\s|$)/.test(shellStructure)) {
    return { level: "forbidden", reasons: ["alias can override commands"] };
  }

  for (const rule of DESTRUCTIVE_PATTERNS) {
    if (rule.pattern.test(shellStructure)) {
      return { level: "destructive_or_process_control", reasons: [rule.reason] };
    }
  }

  // Prefer an observable workspace mutation over network access when a compound
  // command does both. This preserves write-policy enforcement for commands such
  // as `curl ... > file` or `git add ... && git push`.
  for (const rule of WRITE_PATTERNS) {
    const target = rule.scan === "raw" ? trimmed : shellStructure;
    if (rule.pattern.test(target)) {
      return { level: "workspace_write", reasons: [rule.reason] };
    }
  }

  for (const rule of NETWORK_PATTERNS) {
    if (rule.pattern.test(shellStructure)) {
      return { level: "network_or_dependency", reasons: [rule.reason] };
    }
  }

  for (const rule of COMPUTE_PATTERNS) {
    if (rule.pattern.test(shellStructure)) {
      return { level: "local_compute", reasons: [rule.reason] };
    }
  }

  return { level: "read_only", reasons: ["default: read-only"] };
}

export function isCatastrophicCommand(command: string): boolean {
  const shellStructure = maskQuotedLiterals(command.trim());
  return CATASTROPHIC_PATTERNS.some((rule) => rule.pattern.test(shellStructure));
}

function checkDeniedPaths(command: string, deniedPaths: string[]): string | null {
  const pathCandidates = extractPathCandidates(command);
  for (const pattern of deniedPaths) {
    for (const candidate of pathCandidates) {
      if (matchesDeniedPath(pattern, candidate)) {
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

function matchesDeniedPath(pattern: string, candidate: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^~\//, "").replace(/^\/+/, "");
  const normalizedCandidate = candidate.replace(/\\/g, "/").replace(/^~\//, "").replace(/^\/+/, "");

  if (!normalizedPattern.includes("/")) {
    const segmentRegex = globPatternToRegex(normalizedPattern, false);
    return normalizedCandidate.split("/").filter(Boolean).some((segment) => segmentRegex.test(segment));
  }

  const pathRegex = globPatternToRegex(normalizedPattern, true);
  return pathSuffixes(normalizedCandidate).some((suffix) => pathRegex.test(suffix));
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

function globPatternToRegex(pattern: string, allowSlash: boolean): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, allowSlash ? "[^/]*" : ".*")
    .replace(/\?/g, allowSlash ? "[^/]" : ".")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  return new RegExp(`^${escaped}$`, "i");
}

function containsShellCommandInvocation(shellStructure: string, commandName: string): boolean {
  const escapedCommand = commandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const commandPattern = new RegExp(`^${escapedCommand}(?:\\s|$)`);
  const substitutionPattern = new RegExp("(?:\\$\\(|`)\\s*(?:command\\s+|builtin\\s+)?" + escapedCommand + "(?:\\s|$)");

  if (substitutionPattern.test(shellStructure)) {
    return true;
  }

  for (const rawSegment of shellStructure.split(/&&|\|\||[;\n|&]/)) {
    let segment = rawSegment.trim();
    if (!segment) continue;

    segment = segment.replace(/^(?:(?:if|elif|while|until|then|do|else)\s+|!\s*)+/, "");
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
    segment = segment.replace(/^(?:command|builtin)\s+/, "");
    if (commandPattern.test(segment)) {
      return true;
    }
  }

  return false;
}
