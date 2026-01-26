import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool,
  ContentBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { v7 } from "uuid";
import type {
  HarnessModule,
  InvokeParams,
  Message,
  ToolDefinition,
  ToolContext,
  ToolCall,
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

// Convert Zod schema to JSON Schema format for Anthropic
function zodToJsonSchema(schema: ToolDefinition["schema"]): Tool["input_schema"] {
  // Use zod's built-in JSON schema generation if available
  // Otherwise, manually construct the schema from the Zod definition
  if ("_def" in schema && schema._def) {
    const def = schema._def as { typeName?: string; shape?: () => Record<string, unknown> };
    if (def.typeName === "ZodObject" && def.shape) {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const fieldDef = (
          value as { _def?: { typeName?: string; description?: string; innerType?: unknown } }
        )._def;
        if (fieldDef) {
          const isOptional = fieldDef.typeName === "ZodOptional";
          const innerType =
            isOptional && fieldDef.innerType
              ? (fieldDef.innerType as { _def?: { typeName?: string } })._def
              : fieldDef;

          if (!isOptional) {
            required.push(key);
          }

          const typeName = innerType?.typeName;
          let jsonType = "string";
          if (typeName === "ZodNumber") jsonType = "number";
          else if (typeName === "ZodBoolean") jsonType = "boolean";
          else if (typeName === "ZodArray") jsonType = "array";
          else if (typeName === "ZodObject") jsonType = "object";

          properties[key] = {
            type: jsonType,
            ...(fieldDef.description && { description: fieldDef.description }),
          };
        }
      }

      return {
        type: "object" as const,
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }
  }

  // Fallback: assume it's already a JSON schema-like object
  // Cast through unknown to satisfy TypeScript
  return schema as unknown as Tool["input_schema"];
}

function createHarness(apiKey?: string): HarnessModule {
  const client = new Anthropic({
    apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
  });

  return {
    async invoke({ emit, context, ...params }: InvokeParams): Promise<void> {
      const messages = convertMessages(params.messages);
      const system = getSystemMessage(params.messages);
      const tools = params.tools
        ? params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: zodToJsonSchema(t.schema),
          }))
        : undefined;

      const runId = v7(); // Provider always creates its own ID
      const parentId = context?.parentId;

      // Wrap emit to add parentId to events
      const taggedEmit = (event: Parameters<typeof emit>[0]) => {
        emit(parentId ? { ...event, parentId } : event);
      };

      // Track content block IDs for events
      const reasoningId = v7();
      const textId = v7();

      // Determine if we should enable extended thinking
      const enableThinking = supportsThinking(params.model);

      try {
        // Use the streaming helper API
        const streamParams: Anthropic.MessageCreateParams = {
          model: params.model,
          max_tokens: enableThinking ? 16000 : 4096,
          messages,
          ...(system && { system }),
          ...(tools && tools.length > 0 && { tools }),
          ...(enableThinking && {
            thinking: {
              type: "enabled",
              budget_tokens: 8000,
            },
          }),
        };

        const stream = client.messages.stream(streamParams);

        // Collect tool calls for later execution
        const toolCalls: ToolCall[] = [];

        // Listen for thinking/reasoning events
        stream.on("thinking", (thinkingDelta: string) => {
          taggedEmit({ type: "reasoning", runId, id: reasoningId, content: thinkingDelta });
        });

        // Listen for text events
        stream.on("text", (textDelta: string) => {
          taggedEmit({ type: "text", runId, id: textId, content: textDelta });
        });

        // Listen for content block events to track tool use blocks
        stream.on("contentBlock", (block: ContentBlock) => {
          if (block.type === "tool_use") {
            taggedEmit({
              type: "tool_call",
              runId,
              name: block.name,
              id: block.id,
              input: block.input,
            });
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });
          }
        });

        // Wait for the stream to complete
        await stream.finalMessage();

        // Execute tools if they have executors
        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);
          if (!toolDef?.execute) {
            // No executor - that's ok, caller may process tool_call events directly
            continue;
          }

          const toolCtx: ToolContext = {
            emit: taggedEmit,
            parentId: tc.id, // This tool_call becomes parent for nested events
          };

          try {
            const { context: toolContext, result: toolResult } = await toolDef.execute(
              tc.arguments,
              toolCtx,
            );
            // Emit tool_result with context for agent loop (context goes into messages)
            // and result for application consumption
            taggedEmit({
              type: "tool_result",
              runId,
              name: tc.name,
              id: tc.id,
              output: { context: toolContext, result: toolResult },
            });
          } catch (error) {
            taggedEmit({
              type: "error",
              runId,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        }
      } catch (error) {
        taggedEmit({
          type: "error",
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

export const anthropicHarness = createHarness();
export { createHarness };
