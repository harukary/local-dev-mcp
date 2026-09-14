import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { buildToolDefinitions } from "./tool-definitions.js";

const provider = new AjvJsonSchemaValidator();
const validators = new Map<string, JsonSchemaValidator<unknown>>();

export function validateToolInput(name: string, args: unknown): string | undefined {
  let validate = validators.get(name);
  if (!validate) {
    const definition = buildToolDefinitions().find(tool => tool.name === name);
    if (!definition) return `Unknown tool: ${name}`;
    validate = provider.getValidator(definition.inputSchema as JsonSchemaType);
    validators.set(name, validate);
  }
  const result = validate(args ?? {});
  return result.valid ? undefined : result.errorMessage;
}
