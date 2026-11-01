import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { buildToolDefinitions, type ClientToolProfile } from "./tool-definitions.js";

const provider = new AjvJsonSchemaValidator();
const validators = new Map<string, JsonSchemaValidator<unknown>>();

export function validateToolInput(name: string, args: unknown, profile: ClientToolProfile = "chatgpt"): string | undefined {
  const key = `${profile}:${name}`;
  let validate = validators.get(key);
  if (!validate) {
    const definition = buildToolDefinitions(profile).find(tool => tool.name === name);
    if (!definition) return `Unknown tool: ${name}`;
    validate = provider.getValidator(definition.inputSchema as JsonSchemaType);
    validators.set(key, validate);
  }
  const result = validate(args ?? {});
  return result.valid ? undefined : result.errorMessage;
}
