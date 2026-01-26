import { OpenRouter, tool } from "@openrouter/sdk";
import type { z } from "zod";
import { v7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  ToolDefinition,
  ToolCall,
} from "../../types";

/**
 * Convert our Message[] format to OpenRouter SDK input format.
 *
 * Note: OpenRouter's SDK uses camelCase for callId in function_call_output.
 * Assistant tool_calls are tracked internally by the SDK based on the response stream.
 */
function convertMessages(messages: Message[]) {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return { role: "assistant" as const, content: msg.content ?? "" };
    }
    if (msg.role === "tool") {
      return {
        type: "function_call_output" as const,
        callId: msg.tool_call_id,
        output: msg.content,
      };
    }
    return msg;
  });
}

function convertTools(tools: ToolDefinition[]) {
  return tools.map((t) =>
    tool({
      name: t.name,
      description: t.description,
      inputSchema: t.schema as z.ZodObject<z.ZodRawShape>,
      execute: false,
    }),
  );
}

/**
 * Single-iteration OpenRouter harness.
 *
 * This harness makes a single LLM call and yields events for:
 * - text: streamed text content
 * - reasoning: streamed reasoning content
 * - tool_call: tool calls from the model
 * - error: any errors that occur
 *
 * It does NOT:
 * - Execute tools (that's the agent wrapper's job)
 * - Handle permissions (that's the agent wrapper's job)
 * - Loop after tool calls (that's the agent wrapper's job)
 */
function createGeneratorHarness(apiKey?: string): GeneratorHarnessModule {
  const client = new OpenRouter({
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
  });

  return {
    async *invoke({ context, ...params }: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const runId = context?.runId ?? v7();
      const parentId = context?.parentId;
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const input = convertMessages(params.messages);
      const reasoningId = v7();
      const textId = v7();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = client.callModel({
        model: params.model,
        input,
        ...(tools && { tools }),
      } as any);

      const toolCalls: ToolCall[] = [];
      let assistantText = "";

      try {
        for await (const event of result.getFullResponsesStream()) {
          if (event.type === "response.output_text.delta") {
            yield tag({ type: "text", runId, id: textId, content: event.delta });
            assistantText += event.delta;
          } else if (event.type === "response.reasoning_text.delta") {
            yield tag({ type: "reasoning", runId, id: reasoningId, content: event.delta });
          } else if (event.type === "response.function_call_arguments.done") {
            let args: unknown;
            try {
              args = JSON.parse(event.arguments);
            } catch (e) {
              yield tag({
                type: "error",
                runId,
                error: new Error(`Failed to parse tool arguments: ${event.arguments}`),
              });
              return;
            }
            toolCalls.push({ id: event.itemId, name: event.name, arguments: args });
          } else if (event.type === "error") {
            yield tag({
              type: "error",
              runId,
              error: new Error(event.message ?? "Unknown error"),
            });
            return;
          }
        }
      } catch (error) {
        yield tag({
          type: "error",
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      // Yield tool_call events for the agent wrapper to process
      for (const tc of toolCalls) {
        yield tag({
          type: "tool_call",
          runId,
          name: tc.name,
          id: tc.id,
          input: tc.arguments,
        });
      }

      // Single iteration complete - agent wrapper will handle looping
    },

    async supportedModels(): Promise<string[]> {
      const response = await client.models.list();
      return response.data.map((m: { id: string }) => m.id);
    },
  };
}

export const openRouterHarness = createGeneratorHarness();
export { createGeneratorHarness };
