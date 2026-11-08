// Optional host capabilities. An unset setting stays enabled for existing installs.
export const OPTIONAL_FEATURES = ["mobile", "computer", "browser", "repo-actions"] as const;
export type OptionalFeature = (typeof OPTIONAL_FEATURES)[number];

export const FEATURE_ENV: Record<OptionalFeature, string> = {
  mobile: "LOCAL_DEV_MCP_FEATURE_MOBILE",
  computer: "LOCAL_DEV_MCP_FEATURE_COMPUTER",
  browser: "LOCAL_DEV_MCP_FEATURE_BROWSER",
  "repo-actions": "LOCAL_DEV_MCP_FEATURE_REPO_ACTIONS",
};

export function isFeatureEnabled(feature: OptionalFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  const variable = FEATURE_ENV[feature];
  const raw = env[variable]?.trim().toLowerCase();
  if (!raw || ["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new Error(`Invalid ${variable}: expected 1 or 0 (on/off).`);
}

export function isToolFeatureEnabled(toolName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const feature = toolName.startsWith("repo.action.") ? "repo-actions"
    : toolName.startsWith("mobile.") ? "mobile"
    : toolName.startsWith("computer.") ? "computer"
    : toolName.startsWith("browser.") ? "browser" : null;
  return feature === null || isFeatureEnabled(feature, env);
}
