import { z } from 'zod';

import type { AgentTool } from './types';

/**
 * Anthropic Messages API tool definition.
 * See https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 */
export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Convert a shared AgentTool into the JSON-Schema shape Anthropic expects.
 *
 * Uses zod v4's native `z.toJSONSchema`. All tool schemas are plain
 * objects/enums/arrays/unions (no transforms or refinements), so conversion is
 * lossless. The provider boundary keeps this Anthropic-specific for now; a GPT
 * provider would add its own converter without touching the registry.
 */
export function toAnthropicTool(tool: AgentTool): AnthropicToolSchema {
  const jsonSchema = z.toJSONSchema(z.object(tool.inputSchema)) as Record<string, unknown>;

  // Anthropic doesn't use the JSON-Schema dialect marker; drop it to keep payloads lean.
  delete jsonSchema.$schema;

  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema,
  };
}

export function toAnthropicTools(tools: AgentTool[]): AnthropicToolSchema[] {
  return tools.map(toAnthropicTool);
}
