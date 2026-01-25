import { OpenRouter, tool } from "@openrouter/sdk";
import type { z } from "zod";
import { v7 } from "uuid";
import type {
  HarnessModule,
  InvokeParams,
  Message,
  ToolDefinition,
  ToolContext,
  ToolCall,
} from "../types";
import { matchesPermissions } from "../permissions";

function convertMessages(messages: Message[]) {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return {
        role: "assistant" as const,
        content: msg.content ?? "",
      };
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

function createHarness(apiKey?: string): HarnessModule {
  const client = new OpenRouter({
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
  });

  return {
    async invoke({ emit, context, ...params }: InvokeParams): Promise<void> {
      const input = convertMessages(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const runId = context?.runId ?? v7();
      const parentId = context?.parentId;
      const reasoningId = v7();
      const textId = v7();

      // Wrap emit to add parentId to events
      const taggedEmit = (event: Parameters<typeof emit>[0]) => {
        emit(parentId ? { ...event, parentId } : event);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = client.callModel({
        model: params.model,
        input,
        ...(tools && { tools }),
      } as any);

      // Use unified stream to get all events in order (reasoning, text, tool calls)
      const toolCalls: ToolCall[] = [];
      try {
        for await (const event of result.getFullResponsesStream()) {
          // Handle text deltas
          if (event.type === "response.output_text.delta") {
            taggedEmit({ type: "text", runId, id: textId, content: event.delta });
          }
          // Handle reasoning deltas
          else if (event.type === "response.reasoning_text.delta") {
            taggedEmit({ type: "reasoning", runId, id: reasoningId, content: event.delta });
          }
          // Handle completed function calls
          else if (event.type === "response.function_call_arguments.done") {
            const args = JSON.parse(event.arguments);
            taggedEmit({
              type: "tool_call",
              runId,
              name: event.name,
              id: event.itemId,
              input: args,
            });
            toolCalls.push({ id: event.itemId, name: event.name, arguments: args });
          }
          // Handle errors
          else if (event.type === "error") {
            taggedEmit({
              type: "error",
              runId,
              error: new Error(event.message ?? "Unknown error"),
            });
            return;
          }
        }
      } catch (error) {
        taggedEmit({
          type: "error",
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      // Execute tools if executors are provided
      if (tools && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);

          // Check deny list first
          const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
          if (denial) {
            taggedEmit({
              type: "tool_result",
              runId,
              id: tc.id,
              name: tc.name,
              output: { status: "denied", reason: denial.reason },
            });
            continue;
          }

          // Check if allowed (allowlist or allowOnce)
          if (
            params.permissions &&
            !matchesPermissions(
              { name: tc.name, arguments: tc.arguments as Record<string, unknown> | undefined },
              params.permissions,
            )
          ) {
            taggedEmit({
              type: "permission_required",
              runId,
              id: v7(),
              toolCallId: tc.id,
              tool: tc.name,
              params: (tc.arguments ?? {}) as Record<string, unknown>,
            });
            continue;
          }

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
      }
    },

    async supportedModels(): Promise<string[]> {
      const response = await client.models.list();
      return response.data.map((m: { id: string }) => m.id);
    },
  };
}

export const openRouterHarness = createHarness();
export { createHarness };
