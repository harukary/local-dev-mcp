import { describe, expect, it } from "vitest";
import { buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";

describe("notes tool schema", () => {
  it("exposes notes.create_draft and notes.validate", () => {
    const snapshot = buildToolSchemaSnapshot();
    const createDraft = snapshot.tools.find((tool) => tool.name === "notes.create_draft");
    const validate = snapshot.tools.find((tool) => tool.name === "notes.validate");

    expect(createDraft?.inputSchema).toMatchObject({
      type: "object",
      required: ["title"],
    });
    expect(createDraft?.annotations).toMatchObject({ readOnlyHint: false });
    expect(validate?.annotations).toMatchObject({ readOnlyHint: true });
  });
});
