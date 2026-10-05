const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const ACTION_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Action ID declared by the selected repository in .local-dev/actions.json.",
    },
    args: {
      type: "object",
      description: "Structured arguments validated against the selected action's repository-owned input_schema.",
      additionalProperties: true,
    },
  },
  required: ["action"],
  additionalProperties: false,
};

export function buildRepoActionToolDefinitions() {
  return [
    {
      name: "repo.action.list",
      description:
        "List the selected repository's explicitly declared local actions from .local-dev/actions.json. This is read-only and does not discover commands by executing shell.run.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: RO,
    },
    {
      name: "repo.action.read",
      description:
        "Execute one repository-declared read action. The action must be registered as mode=read in .local-dev/actions.json; arbitrary shell text is not accepted. This initial surface is local-only and rejects actions declared as external/networked.",
      inputSchema: ACTION_INPUT_SCHEMA,
      annotations: RO,
    },
    {
      name: "repo.action.write",
      description:
        "Execute one repository-declared non-destructive local write action. The action must be registered as mode=write in .local-dev/actions.json; arbitrary shell text is not accepted. The selected project must allow writes, and this initial surface rejects external/networked actions.",
      inputSchema: ACTION_INPUT_SCHEMA,
      annotations: WA,
    },
  ];
}
