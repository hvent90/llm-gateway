import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { v7 } from "uuid";
import { toJSONSchema } from "zod";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  ToolDefinition,
} from "../../types";

// Models that support extended thinking
const THINKING_MODELS = ["claude-sonnet-4-5-20250929", "claude-3-7-sonnet-20250219"];

function supportsThinking(model: string): boolean {
  return THINKING_MODELS.some(
    (m) => model.includes(m) || model.startsWith(m.split("-").slice(0, 3).join("-")),
  );
}

function convertMessages(messages: Message[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // System messages are handled separately in Anthropic's API
      continue;
    }

    if (msg.role === "user") {
      result.push({
        role: "user",
        content: msg.content,
      });
    } else if (msg.role === "assistant") {
      const contentBlocks: ContentBlockParam[] = [];

      // Add text content if present
      if (msg.content) {
        contentBlocks.push({
          type: "text",
          text: msg.content,
        });
      }

      // Add tool use blocks if present
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments ?? {},
          });
        }
      }

      if (contentBlocks.length > 0) {
        result.push({
          role: "assistant",
          content: contentBlocks,
        });
      }
    } else if (msg.role === "tool") {
      // Tool results go in user messages with tool_result blocks
      const toolResult: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      };

      // Check if the last message is a user message with tool results
      const lastMsg = result[result.length - 1];
      if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        // Append to existing user message
        (lastMsg.content as ContentBlockParam[]).push(toolResult);
      } else {
        // Create new user message with tool result
        result.push({
          role: "user",
          content: [toolResult],
        });
      }
    }
  }

  return result;
}

function getSystemMessage(messages: Message[]): string | undefined {
  const systemMsg = messages.find((m) => m.role === "system");
  return systemMsg ? systemMsg.content : undefined;
}

function convertTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toJSONSchema(t.schema) as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Single-iteration Anthropic harness using the Messages API with SSE streaming.
 *
 * This harness makes a single LLM call and yields events for:
 * - reasoning: streamed thinking content
 * - text: streamed text content
 * - tool_call: tool calls from the model
 * - error: any errors that occur
 *
 * It does NOT:
 * - Execute tools (that's the agent wrapper's job)
 * - Handle permissions (that's the agent wrapper's job)
 * - Loop after tool calls (that's the agent wrapper's job)
 */
function createGeneratorHarness(apiKey?: string): GeneratorHarnessModule {
  const client = new Anthropic({
    apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
  });

  return {
    async *invoke({ context, ...params }: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const runId = v7();
      const parentId = context?.parentId;
      const reasoningId = v7();
      const textId = v7();

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const messages = convertMessages(params.messages);
      const system = getSystemMessage(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const enableThinking = supportsThinking(params.model);

      try {
        const stream = await client.messages.create({
          model: params.model,
          max_tokens: enableThinking ? 16000 : 4096,
          messages,
          ...(system && { system }),
          ...(tools && tools.length > 0 && { tools }),
          ...(enableThinking && {
            thinking: {
              type: "enabled" as const,
              budget_tokens: 8000,
            },
          }),
          stream: true as const,
        });

        // Track tool calls by content block index
        const toolCallsMap: Record<number, { id: string; name: string; arguments: string }> = {};

        for await (const event of stream) {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              toolCallsMap[event.index] = {
                id: event.content_block.id,
                name: event.content_block.name,
                arguments: "",
              };
            }
          }

          if (event.type === "content_block_delta") {
            if (event.delta.type === "thinking_delta") {
              yield tag({
                type: "reasoning" as const,
                runId,
                id: reasoningId,
                content: event.delta.thinking,
              });
            } else if (event.delta.type === "text_delta") {
              yield tag({
                type: "text" as const,
                runId,
                id: textId,
                content: event.delta.text,
              });
            } else if (event.delta.type === "input_json_delta") {
              const tracked = toolCallsMap[event.index];
              if (tracked) {
                tracked.arguments += event.delta.partial_json;
              }
            }
          }
        }

        // Yield tool_call events for the agent wrapper to process
        for (const tc of Object.values(toolCallsMap)) {
          let args: unknown;
          try {
            args = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            yield tag({
              type: "error" as const,
              runId,
              error: new Error(`Failed to parse tool arguments: ${tc.arguments}`),
            });
            return;
          }
          yield tag({
            type: "tool_call" as const,
            runId,
            name: tc.name,
            id: tc.id,
            input: args,
          });
        }
      } catch (error) {
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },

    async supportedModels(): Promise<string[]> {
      try {
        const models: string[] = [];
        for await (const model of client.models.list()) {
          models.push(model.id);
        }
        return models;
      } catch {
        // Fallback to known models if API doesn't support listing
        return [
          "claude-opus-4-20250514",
          "claude-sonnet-4-20250514",
          "claude-sonnet-4-5-20250929",
          "claude-3-7-sonnet-20250219",
          "claude-3-5-sonnet-20241022",
          "claude-3-5-haiku-20241022",
          "claude-3-opus-20240229",
          "claude-3-sonnet-20240229",
          "claude-3-haiku-20240307",
        ];
      }
    },
  };
}

export const anthropicHarness = createGeneratorHarness();
export { createGeneratorHarness };
