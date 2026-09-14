type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };

export async function observeAfterAction<T extends ToolResult>(action: string, operation: () => Promise<T>) {
  try {
    const result = await operation();
    if (!result.isError) return result;
    let observation = result.structuredContent;
    if (observation === undefined) {
      const text = result.content.find(item => item.type === "text")?.text ?? "";
      try { observation = JSON.parse(text); } catch { observation = { message: text }; }
    }
    const value = { action, action_applied: true, observation_ok: false, retry_action: false, observation };
    return { structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }], isError: true };
  } catch (error) {
    const value = { action, action_applied: true, observation_ok: false, retry_action: false, error: { code: "OBSERVATION_FAILED", message: error instanceof Error ? error.message : String(error) } };
    return { structuredContent: value, content: [{ type: "text" as const, text: JSON.stringify(value) }], isError: true };
  }
}
