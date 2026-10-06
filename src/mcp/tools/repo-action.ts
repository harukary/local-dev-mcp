import { readFile } from "node:fs/promises";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type { AppContext } from "../server.js";
import type { ProjectConfig, RiskLevel } from "../../types.js";
import { classifyRisk, isCatastrophicCommand } from "../../shell/risk-classifier.js";
import { getActiveProject, jsonError, jsonResult, resolveProjectPath, sha256 } from "./dev/common.js";

const MANIFEST_PATH = ".local-dev/actions.json";
const ACTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const validatorProvider = new AjvJsonSchemaValidator();

type ActionMode = "read" | "write";
type ActionArgToken = string | { param: string; encoding?: "scalar" | "json" };

type RepoAction = {
  mode: ActionMode;
  description?: string;
  executable: string;
  argv?: ActionArgToken[];
  input_schema?: Record<string, unknown>;
  timeout_seconds?: number;
  network?: boolean;
};

type RepoActionManifest = {
  version: 1;
  actions: Record<string, RepoAction>;
};

type LoadedManifest = {
  path: string;
  hash: string;
  manifest: RepoActionManifest;
};

function manifestError(code: string, message: string, details?: unknown) {
  return { ok: false as const, result: jsonError(code, message, details) };
}

async function loadManifest(project: ProjectConfig, optional = false) {
  const resolved = resolveProjectPath(project, MANIFEST_PATH);
  if (!resolved.ok) return manifestError(resolved.code, resolved.message);

  let raw: string;
  try {
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) {
      return { ok: true as const, manifest: null };
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return manifestError("ACTION_MANIFEST_NOT_FOUND", `No repository action manifest found at ${MANIFEST_PATH}.`);
    }
    return manifestError("ACTION_MANIFEST_READ_FAILED", error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return manifestError("ACTION_MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return manifestError("ACTION_MANIFEST_INVALID", "Action manifest must be a JSON object.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1 || !candidate.actions || typeof candidate.actions !== "object" || Array.isArray(candidate.actions)) {
    return manifestError("ACTION_MANIFEST_INVALID", "Action manifest requires version=1 and an actions object.");
  }

  const actions = candidate.actions as Record<string, unknown>;
  for (const [id, rawAction] of Object.entries(actions)) {
    if (!ACTION_ID_PATTERN.test(id)) {
      return manifestError("ACTION_MANIFEST_INVALID", `Invalid action id: ${id}`);
    }
    const valid = validateActionDefinition(id, rawAction);
    if (!valid.ok) return valid;
  }

  return {
    ok: true as const,
    manifest: {
      path: MANIFEST_PATH,
      hash: sha256(raw),
      manifest: parsed as RepoActionManifest,
    } satisfies LoadedManifest,
  };
}

function validateActionDefinition(id: string, rawAction: unknown) {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} must be an object.`);
  }
  const action = rawAction as Record<string, unknown>;
  if (action.mode !== "read" && action.mode !== "write") {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} requires mode=read or mode=write.`);
  }
  if (typeof action.executable !== "string" || !action.executable.trim() || /[\r\n\0]/.test(action.executable)) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} requires a valid executable string.`);
  }
  if (action.network !== undefined && typeof action.network !== "boolean") {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} network must be boolean when present.`);
  }
  if (action.timeout_seconds !== undefined && (!Number.isInteger(action.timeout_seconds) || Number(action.timeout_seconds) < 1 || Number(action.timeout_seconds) > 240)) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} timeout_seconds must be an integer from 1 to 240.`);
  }
  if (action.input_schema !== undefined && (!action.input_schema || typeof action.input_schema !== "object" || Array.isArray(action.input_schema))) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} input_schema must be an object.`);
  }
  if (action.argv !== undefined) {
    if (!Array.isArray(action.argv)) {
      return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} argv must be an array.`);
    }
    for (const token of action.argv) {
      if (typeof token === "string") {
        if (/[\r\n\0]/.test(token)) return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} argv contains an invalid fixed token.`);
        continue;
      }
      if (!token || typeof token !== "object" || Array.isArray(token)) {
        return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} argv tokens must be strings or parameter references.`);
      }
      const ref = token as Record<string, unknown>;
      if (typeof ref.param !== "string" || !ref.param || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(ref.param)) {
        return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} has an invalid argv parameter reference.`);
      }
      if (ref.encoding !== undefined && ref.encoding !== "scalar" && ref.encoding !== "json") {
        return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} argv parameter encoding must be scalar or json.`);
      }
    }
  }

  const closedWorld = validateClosedWorldExecution(id, action as unknown as RepoAction);
  if (!closedWorld.ok) return closedWorld;
  return { ok: true as const };
}

function executableBasename(executable: string): string {
  return executable.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? executable.toLowerCase();
}

function validateClosedWorldExecution(id: string, action: RepoAction) {
  const base = executableBasename(action.executable);
  const argv = action.argv ?? [];
  const fixed = argv.filter((token): token is string => typeof token === "string");
  const shellExecutables = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
  const dispatchExecutables = new Set(["env", "xargs"]);

  if (shellExecutables.has(base) || base === "eval") {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} may not invoke a shell/eval executable. Repository actions must execute a fixed program directly.`);
  }
  if (dispatchExecutables.has(base)) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} may not use generic command dispatch executable ${base}.`);
  }

  const evalFlags: Record<string, Set<string>> = {
    node: new Set(["-e", "--eval", "-p", "--print"]),
    bun: new Set(["-e", "--eval", "-p", "--print"]),
    deno: new Set(["eval"]),
    python: new Set(["-c"]),
    python3: new Set(["-c"]),
    perl: new Set(["-e"]),
    ruby: new Set(["-e"]),
    php: new Set(["-r"]),
  };
  const forbiddenFlags = evalFlags[base];
  if (forbiddenFlags && fixed.some((token) => forbiddenFlags.has(token))) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} may not use interpreter eval/code flags through repo.action.`);
  }

  if (base === "find" && fixed.some((token) => token === "-exec" || token === "-execdir")) {
    return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} may not use find -exec/-execdir through repo.action.`);
  }

  if (["pnpm", "npm", "yarn", "bun"].includes(base)) {
    for (let index = 0; index < argv.length - 1; index += 1) {
      const token = argv[index];
      const next = argv[index + 1];
      if (typeof token === "string" && ["exec", "dlx", "x"].includes(token) && typeof next !== "string") {
        return manifestError("ACTION_MANIFEST_INVALID", `Action ${id} may not select a package-manager executable from model input.`);
      }
    }
  }

  return { ok: true as const };
}

function publicActions(loaded: LoadedManifest) {
  return Object.entries(loaded.manifest.actions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, action]) => ({
      id,
      mode: action.mode,
      description: action.description ?? "",
      input_schema: action.input_schema ?? { type: "object", properties: {}, additionalProperties: false },
      timeout_seconds: action.timeout_seconds ?? null,
      network: action.network ?? false,
    }));
}

function encodeParam(actionId: string, param: string, value: unknown, encoding: "scalar" | "json") {
  if (encoding === "json") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error(`Action ${actionId} parameter ${param} cannot be JSON encoded.`);
    return encoded;
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return String(value);
  throw new Error(`Action ${actionId} parameter ${param} must be a scalar or use encoding=json.`);
}

function buildArgv(id: string, action: RepoAction, args: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const token of action.argv ?? []) {
    if (typeof token === "string") {
      values.push(token);
      continue;
    }
    if (!Object.hasOwn(args, token.param)) {
      throw new Error(`Action ${id} missing argv parameter: ${token.param}`);
    }
    values.push(encodeParam(id, token.param, args[token.param], token.encoding ?? "scalar"));
  }
  return values;
}

function buildRiskCommand(action: RepoAction): string {
  const tokens = [action.executable, ...(action.argv ?? []).map((token) => typeof token === "string" ? token : "__repo_action_param__")];
  return tokens.join(" ");
}

function validateActionArgs(id: string, action: RepoAction, args: Record<string, unknown>) {
  const schema = action.input_schema ?? { type: "object", properties: {}, additionalProperties: false };
  try {
    const validate = validatorProvider.getValidator(schema as JsonSchemaType);
    const result = validate(args);
    if (!result.valid) return jsonError("ACTION_ARGUMENT_INVALID", result.errorMessage ?? `Invalid arguments for action ${id}.`);
    return null;
  } catch (error) {
    return jsonError("ACTION_MANIFEST_INVALID", `Action ${id} has an invalid input_schema.`, error instanceof Error ? error.message : String(error));
  }
}

function readModeRiskAllowed(level: RiskLevel): boolean {
  return level === "read_only" || level === "local_compute";
}

function writeModeRiskAllowed(level: RiskLevel): boolean {
  return level === "read_only" || level === "local_compute" || level === "workspace_write";
}

async function executeAction(
  ctx: AppContext,
  chatContextId: string,
  requestedMode: ActionMode,
  args: { action?: string; args?: Record<string, unknown> }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.action) return jsonError("ACTION_REQUIRED", "repo.action execution requires action.");

  const loaded = await loadManifest(project);
  if (!loaded.ok) return loaded.result;
  if (!loaded.manifest) return jsonError("ACTION_MANIFEST_NOT_FOUND", `No repository action manifest found at ${MANIFEST_PATH}.`);

  const action = loaded.manifest.manifest.actions[args.action];
  if (!action) {
    return jsonError("ACTION_NOT_FOUND", `Unknown repository action: ${args.action}`, {
      available_actions: publicActions(loaded.manifest).map((item) => item.id),
    });
  }
  if (action.mode !== requestedMode) {
    return jsonError("ACTION_MODE_MISMATCH", `Action ${args.action} is declared as mode=${action.mode}, not mode=${requestedMode}.`);
  }
  if (action.network) {
    return jsonError("ACTION_EXTERNAL_UNSUPPORTED", "repo.action currently supports only local actions. Use the repository's existing external-operation contract for networked actions.");
  }
  if (requestedMode === "write" && project.writePolicy !== "allow") {
    return jsonError("ACTION_WRITE_NOT_ALLOWED", `Project write policy is ${project.writePolicy}; repo.action.write currently requires write_policy=allow.`);
  }

  const actionArgs = args.args ?? {};
  const invalidArgs = validateActionArgs(args.action, action, actionArgs);
  if (invalidArgs) return invalidArgs;

  let argv: string[];
  try {
    argv = buildArgv(args.action, action, actionArgs);
  } catch (error) {
    return jsonError("ACTION_ARGUMENT_INVALID", error instanceof Error ? error.message : String(error));
  }

  const riskCommand = buildRiskCommand(action);
  const risk = classifyRisk(riskCommand, project.deniedPaths);
  if (risk.level === "forbidden" || isCatastrophicCommand(riskCommand)) {
    return jsonError("ACTION_COMMAND_REJECTED", "Repository action resolved to a forbidden or catastrophic command.", {
      action: args.action,
      risk_level: risk.level,
      reasons: risk.reasons,
    });
  }
  if (requestedMode === "read" && !readModeRiskAllowed(risk.level)) {
    return jsonError("ACTION_MODE_RISK_MISMATCH", "Repository read action resolved to a command classified as write/network/destructive.", {
      action: args.action,
      risk_level: risk.level,
      reasons: risk.reasons,
    });
  }
  if (requestedMode === "write" && !writeModeRiskAllowed(risk.level)) {
    return jsonError("ACTION_MODE_RISK_MISMATCH", "Repository write action resolved to a command classified as network/destructive.", {
      action: args.action,
      risk_level: risk.level,
      reasons: risk.reasons,
    });
  }

  const result = await ctx.shellRunner.runArgv(project, {
    executable: action.executable,
    args: argv,
    riskCommand,
    timeoutSeconds: action.timeout_seconds,
    purpose: action.description ?? args.action,
  }, chatContextId);

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: requestedMode === "read" ? "repo.action.read" : "repo.action.write",
    event: "repo_action_executed",
    projectId: project.projectId,
    command: args.action,
    purpose: action.description,
    riskLevel: result.riskLevel,
    enforcement: "audit_only",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    redactions: result.redactions,
  });

  const payload = {
    project_id: result.projectId,
    action: args.action,
    mode: requestedMode,
    catalog_version: loaded.manifest.hash,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
    redactions: result.redactions,
  };

  const response = jsonResult(payload);
  return result.exitCode === 0 && !result.timedOut ? response : { ...response, isError: true };
}

export async function handleRepoActionList(ctx: AppContext, chatContextId: string) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const loaded = await loadManifest(project, true);
  if (!loaded.ok) return loaded.result;
  if (!loaded.manifest) {
    return jsonResult({
      project_id: project.projectId,
      manifest_path: MANIFEST_PATH,
      catalog_version: null,
      actions: [],
    });
  }
  return jsonResult({
    project_id: project.projectId,
    manifest_path: loaded.manifest.path,
    catalog_version: loaded.manifest.hash,
    actions: publicActions(loaded.manifest),
  });
}

export async function handleRepoActionRead(
  ctx: AppContext,
  chatContextId: string,
  args: { action?: string; args?: Record<string, unknown> }
) {
  return await executeAction(ctx, chatContextId, "read", args);
}

export async function handleRepoActionWrite(
  ctx: AppContext,
  chatContextId: string,
  args: { action?: string; args?: Record<string, unknown> }
) {
  return await executeAction(ctx, chatContextId, "write", args);
}
