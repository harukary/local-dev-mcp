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
        "List repository-declared local, host-approved credentialed read, and deployment actions from .local-dev/actions.json, with their fixed modes, argument schemas, and network/credential metadata. This is read-only and never executes discovery commands.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: RO,
    },
    {
      name: "repo.action.read",
      description:
        "Execute a repository-declared fixed-argv read action. Networked Bitwarden reads require operation=credentialed_read and a matching action fingerprint in host-owned project configuration; arbitrary shell text is rejected.",
      inputSchema: ACTION_INPUT_SCHEMA,
      annotations: RO,
    },
    {
      name: "repo.action.write",
      description:
        "Execute a repository-declared write action by ID with validated arguments. Ordinary actions are local-only. Credentialed/networked deployment requires a declared operation=deployment, fixed argv, a clean pushed Git HEAD matching expected_head, and project write/network permission; arbitrary shell input is not accepted.",
      inputSchema: ACTION_INPUT_SCHEMA,
      annotations: WA,
    },
  ];
}
