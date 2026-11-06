import type { AppContext } from "../server.js";
import type { FeedbackKind, FeedbackReport, FeedbackStatus, FeedbackUpdate, FeedbackQuery } from "../../feedback/store.js";
import { jsonError, jsonResult } from "./dev/common.js";

function feedbackError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (["FEEDBACK_NOT_FOUND", "FEEDBACK_MISMATCH", "FEEDBACK_STORE_FULL", "FEEDBACK_RESOLUTION_REQUIRED"].includes(message)) {
    return jsonError(message, {
      FEEDBACK_NOT_FOUND: "Feedback report not found.",
      FEEDBACK_MISMATCH: "The existing report has a different kind or project.",
      FEEDBACK_STORE_FULL: "Feedback store reached its 5000-item capacity.",
      FEEDBACK_RESOLUTION_REQUIRED: "Provide a resolution or dismissal rationale before closing feedback.",
    }[message] ?? message);
  }
  throw error;
}

function projectId(ctx: AppContext, chatContextId: string, explicit?: string): string | undefined {
  if (explicit !== undefined && !ctx.registry.has(explicit)) return undefined;
  const selected = ctx.contextStore.getCurrentProject(chatContextId);
  return explicit ?? (selected && ctx.registry.has(selected) ? selected : undefined);
}

export async function handleFeedbackReport(ctx: AppContext, chatContextId: string, args: {
  kind: FeedbackKind; title: string; description: string; impact?: string; suggestion?: string;
  related_tool?: string; project_id?: string; existing_id?: string;
}) {
  if (args.project_id && !ctx.registry.has(args.project_id)) {
    return jsonError("PROJECT_NOT_FOUND", "The specified feedback project is not registered.");
  }
  if (!args.title.trim() || !args.description.trim()) {
    return jsonError("INVALID_ARGUMENT", "Feedback title and description must contain text.");
  }
  const input: FeedbackReport = {
    ...args,
    project_id: projectId(ctx, chatContextId, args.project_id),
    source: ctx.clientProfile ?? "chatgpt",
  };
  try {
    const result = await ctx.feedbackStore.report(input);
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(), chatContextId,
      tool: "feedback.report", event: result.created ? "feedback_created" : result.reopened ? "feedback_reopened" : "feedback_repeated",
    });
    return jsonResult(result);
  } catch (error) {
    return feedbackError(error);
  }
}

export async function handleFeedbackList(ctx: AppContext, args: FeedbackQuery) {
  return jsonResult(await ctx.feedbackStore.list(args));
}

export async function handleFeedbackUpdate(ctx: AppContext, chatContextId: string, args: FeedbackUpdate) {
  if (!args.status && args.note === undefined && args.resolution === undefined) {
    return jsonError("INVALID_ARGUMENT", "Provide status, note, or resolution to update the report.");
  }
  try {
    const item = await ctx.feedbackStore.update(args);
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(), chatContextId,
      tool: "feedback.update", event: "feedback_updated",
    });
    return jsonResult({ item });
  } catch (error) {
    return feedbackError(error);
  }
}
