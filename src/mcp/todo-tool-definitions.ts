const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const EXTERNAL_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const todoId = { type: "string", description: "Todo ID returned by todo.list, todo.get, or another todo tool." };
const project = { type: "string", description: "Todo project ID or exact project name, such as recipie or Inbox." };

export function buildTodoToolDefinitions() {
  return [
    {
      name: "todo.projects",
      description: "List haruclaw Todo projects and their Discord/repository bindings. Independent of the selected local-dev project.",
      inputSchema: {
        type: "object",
        properties: {
          include_archived: { type: "boolean", description: "Include archived projects. Defaults to false." },
        },
      },
      annotations: RO,
    },
    {
      name: "todo.list",
      description: "List haruclaw Todos. Optionally filter by project and completed state.",
      inputSchema: {
        type: "object",
        properties: {
          project,
          completed: { type: "boolean", description: "When true, list completed Todos. Requires project." },
        },
      },
      annotations: RO,
    },
    {
      name: "todo.get",
      description: "Read one haruclaw Todo by ID.",
      inputSchema: {
        type: "object",
        properties: { todo_id: todoId },
        required: ["todo_id"],
      },
      annotations: RO,
    },
    {
      name: "todo.create",
      description: "Create a human-facing haruclaw Todo, optionally as a child of an existing Todo.",
      inputSchema: {
        type: "object",
        properties: {
          project,
          title: { type: "string", description: "Todo title." },
          note: { type: "string", description: "Optional note, background, or completion criteria." },
          parent_id: { ...todoId, description: "Optional parent Todo ID. Only one child level is supported." },
        },
        required: ["project", "title"],
      },
      annotations: WA,
    },
    {
      name: "todo.update",
      description: "Update the title and/or note of an existing haruclaw Todo.",
      inputSchema: {
        type: "object",
        properties: {
          todo_id: todoId,
          title: { type: "string", description: "New title. Omit to keep the current title." },
          note: { type: "string", description: "New note. Omit to keep the current note; pass an empty string to clear it." },
        },
        required: ["todo_id"],
      },
      annotations: WA,
    },
    {
      name: "todo.decompose",
      description: "Decompose one parent Todo into one-level child Todos. Existing children are preserved. Use only when the user asks for decomposition.",
      inputSchema: {
        type: "object",
        properties: {
          todo_id: todoId,
          children: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                note: { type: "string" },
              },
              required: ["title"],
            },
          },
        },
        required: ["todo_id", "children"],
      },
      annotations: WA,
    },
    {
      name: "todo.set_completed",
      description: "Complete or reopen a haruclaw Todo. Completing a parent also completes its children.",
      inputSchema: {
        type: "object",
        properties: {
          todo_id: todoId,
          completed: { type: "boolean" },
        },
        required: ["todo_id", "completed"],
      },
      annotations: WA,
    },
    {
      name: "todo.move",
      description: "Move or reorder a haruclaw Todo. Moving a child to another project makes it a top-level Todo unless parent_id is supplied.",
      inputSchema: {
        type: "object",
        properties: {
          todo_id: todoId,
          project,
          parent_id: { ...todoId, description: "Optional parent Todo ID in the destination project." },
          index: { type: "integer", minimum: 0, description: "Zero-based destination index. Defaults to the end." },
        },
        required: ["todo_id", "project"],
      },
      annotations: WA,
    },
    {
      name: "todo.delete",
      description: "Delete a haruclaw Todo. Deleting a parent also deletes its children.",
      inputSchema: {
        type: "object",
        properties: { todo_id: todoId },
        required: ["todo_id"],
      },
      annotations: DESTRUCTIVE,
    },
    {
      name: "todo.discord",
      description: "Create or return the Discord thread linked to a haruclaw Todo.",
      inputSchema: {
        type: "object",
        properties: { todo_id: todoId },
        required: ["todo_id"],
      },
      annotations: EXTERNAL_WRITE,
    },
  ];
}
