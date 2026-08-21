import { InvalidScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const OAUTH_SCOPES_SUPPORTED = ["all", "offline_access"] as const;

const SUPPORTED_SCOPE_SET = new Set<string>(OAUTH_SCOPES_SUPPORTED);

export function resolveAuthorizationScopes(requestedScopes: string[] | undefined): string[] {
  const scopes = uniqueNonEmptyScopes(requestedScopes);
  if (scopes.length === 0) return ["all"];

  assertSupportedScopes(scopes);
  return scopes;
}

export function resolveRefreshScopes(
  authorizedScopes: string[],
  requestedScopes: string[] | undefined
): string[] {
  const scopes = uniqueNonEmptyScopes(requestedScopes);
  if (scopes.length === 0) return authorizedScopes;

  assertSupportedScopes(scopes);
  const authorized = new Set(authorizedScopes);
  const expanded = scopes.filter((scope) => !authorized.has(scope));
  if (expanded.length > 0) {
    throw new InvalidScopeError(`Refresh scope exceeds the original grant: ${expanded.join(", ")}`);
  }
  return scopes;
}

function uniqueNonEmptyScopes(scopes: string[] | undefined): string[] {
  return Array.from(new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean)));
}

function assertSupportedScopes(scopes: string[]): void {
  const unsupported = scopes.filter((scope) => !SUPPORTED_SCOPE_SET.has(scope));
  if (unsupported.length > 0) {
    throw new InvalidScopeError(`Unsupported scope: ${unsupported.join(", ")}`);
  }
}
