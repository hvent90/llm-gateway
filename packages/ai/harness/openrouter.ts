import { OpenRouter, tool } from "@openrouter/sdk";
import type { z } from "zod";
import { v7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  ToolDefinition,
  ToolContext,
  ToolCall,
} from "../types";
import { matchesPermissions } from "../permissions";
import { deferred } from "../primitives";

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

      // Mutable messages array for the agent loop
      const messages = [...params.messages];

      while (true) {
        const input = convertMessages(messages);
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

        // No tool calls - we're done
        if (toolCalls.length === 0) {
          return;
        }

        // Add assistant message with tool calls to history
        messages.push({ role: "assistant", content: assistantText || null, tool_calls: toolCalls });

        // Process each tool call
        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);
          const args = (tc.arguments ?? {}) as Record<string, unknown>;

          // Check deny list first
          const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
          if (denial) {
            const output = { status: "denied", reason: denial.reason };
            yield tag({ type: "tool_result", runId, id: tc.id, name: tc.name, output });
            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
            continue;
          }

          // Check if allowed (allowlist or allowOnce)
          const isAllowed =
            params.permissions &&
            matchesPermissions({ name: tc.name, arguments: args }, params.permissions);

          if (!isAllowed) {
            // Need permission - create deferred and yield permission_required
            const { promise, resolve } = deferred<{ approved: boolean; reason?: string }>();
            yield tag({
              type: "permission_required",
              runId,
              id: v7(),
              toolCallId: tc.id,
              tool: tc.name,
              params: args,
              respond: (approved, reason) => resolve({ approved, reason }),
            });

            // Generator pauses here until respond() is called
            const decision = await promise;

            if (!decision.approved) {
              const output = { status: "denied", reason: decision.reason };
              yield tag({ type: "tool_result", runId, id: tc.id, name: tc.name, output });
              messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
              continue;
            }
          }

          // Permission granted or in allowlist - yield tool_call and execute
          yield tag({ type: "tool_call", runId, name: tc.name, id: tc.id, input: args });

          if (!toolDef?.execute) {
            // No executor - add placeholder to messages
            messages.push({ role: "tool", tool_call_id: tc.id, content: "Tool not implemented" });
            continue;
          }

          const toolCtx: ToolContext = {
            parentId: tc.id, // This tool_call becomes parent for nested events
          };

          try {
            const { context: toolContext, result: toolResult } = await toolDef.execute(
              tc.arguments,
              toolCtx,
            );
            const output = { context: toolContext, result: toolResult };
            yield tag({ type: "tool_result", runId, name: tc.name, id: tc.id, output });
            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output) });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            yield tag({
              type: "error",
              runId,
              error: error instanceof Error ? error : new Error(errorMsg),
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ error: errorMsg }),
            });
          }
        }

        // Loop continues - will call LLM again with tool results
      }
    },

    async supportedModels(): Promise<string[]> {
      const response = await client.models.list();
      return response.data.map((m: { id: string }) => m.id);
    },
  };
}

export const openRouterHarness = createGeneratorHarness();
export { createGeneratorHarness };
