import { describe, expect, it } from "vitest";
import { buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";

describe("notes tool schema", () => {
  it("exposes notes.guidelines, notes.create, notes.validate, and private_notes tools", () => {
    const snapshot = buildToolSchemaSnapshot();
    const guidelines = snapshot.tools.find((tool) => tool.name === "notes.guidelines");
    const createDraft = snapshot.tools.find((tool) => tool.name === "notes.create");
    const validate = snapshot.tools.find((tool) => tool.name === "notes.validate");
    const privateGuidelines = snapshot.tools.find((tool) => tool.name === "private_notes.guidelines");
    const privateCreate = snapshot.tools.find((tool) => tool.name === "private_notes.create");
    const privateValidate = snapshot.tools.find((tool) => tool.name === "private_notes.validate");

    expect(guidelines?.annotations).toMatchObject({ readOnlyHint: true });
    expect(createDraft?.inputSchema).toMatchObject({
      type: "object",
      required: ["title", "description", "body"],
    });
    expect(createDraft?.annotations).toMatchObject({ readOnlyHint: false });
    expect(validate?.annotations).toMatchObject({ readOnlyHint: true });
    expect(privateGuidelines?.annotations).toMatchObject({ readOnlyHint: true });
    expect(privateCreate?.description).toContain("independent of the currently selected project");
    expect(privateCreate?.inputSchema).toMatchObject({
      type: "object",
      required: ["title", "body_html"],
    });
    expect(privateCreate?.annotations).toMatchObject({ readOnlyHint: false });
    expect(privateValidate?.annotations).toMatchObject({ readOnlyHint: true });
  });
});
