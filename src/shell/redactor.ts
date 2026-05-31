import type { Redaction } from "../types.js";

interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_PATTERNS: RedactionPattern[] = [
  { name: "bearer_token", pattern: /Authorization:\s*Bearer\s+\S+/gi, replacement: "Authorization: Bearer [REDACTED]" },
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: "sk-[REDACTED]" },
  { name: "github_pat", pattern: /ghp_[A-Za-z0-9]{36,}/g, replacement: "ghp_[REDACTED]" },
  { name: "github_pat_v2", pattern: /github_pat_[A-Za-z0-9_]{50,}/g, replacement: "github_pat_[REDACTED]" },
  { name: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g, replacement: "AKIA[REDACTED]" },
  { name: "aws_secret_key", pattern: /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[:=]\s*\S+/g, replacement: "$1: [REDACTED]" },
  { name: "private_key", pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: "[PRIVATE KEY REDACTED]" },
  { name: "openssh_key", pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g, replacement: "[OPENSSH PRIVATE KEY REDACTED]" },
  { name: "cookie_header", pattern: /Cookie:\s*.+/gi, replacement: "Cookie: [REDACTED]" },
  { name: "set_cookie_header", pattern: /Set-Cookie:\s*.+/gi, replacement: "Set-Cookie: [REDACTED]" },
];

const STRICT_PATTERNS: RedactionPattern[] = [
  ...DEFAULT_PATTERNS,
  { name: "env_var_secret", pattern: /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS)\s*[:=]\s*\S+/gi, replacement: "$1: [REDACTED]" },
  { name: "database_url", pattern: /(?:DATABASE_URL|POSTGRES_URL|MONGODB_URI|REDIS_URL)\s*[:=]\s*\S+/gi, replacement: "$1: [REDACTED]" },
  { name: "jwt_token", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[JWT REDACTED]" },
];

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

export function redactOutput(text: string, profile: "default" | "strict" = "default"): RedactResult {
  const patterns = profile === "strict" ? STRICT_PATTERNS : DEFAULT_PATTERNS;
  const redactions: Redaction[] = [];
  let result = text;

  for (const rp of patterns) {
    const matches = result.match(rp.pattern);
    if (matches) {
      redactions.push({ type: rp.name, count: matches.length });
      result = result.replace(rp.pattern, rp.replacement);
    }
  }

  return { text: result, redactions };
}
