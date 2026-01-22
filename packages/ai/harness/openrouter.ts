import { OpenRouter, tool } from "@openrouter/sdk";
import type { z } from "zod";
import {v7} from "uuid";
import type { HarnessModule, InvokeParams, Message, ToolDefinition, ToolContext, ToolCall } from "../types";

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
    async invoke({ emit, runId: providedRunId, context, ...params }: InvokeParams): Promise<void> {
      const input = convertMessages(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const runId = providedRunId ?? v7();
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

      // Stream reasoning (for o1 and similar models)
      try {
        for await (const delta of result.getReasoningStream()) {
          taggedEmit({ type: "reasoning", runId, id: reasoningId, content: delta });
        }
      } catch {
        // Model may not support reasoning - that's ok
      }

      // Stream text
      try {
        for await (const delta of result.getTextStream()) {
          taggedEmit({ type: "text", runId, id: textId, content: delta });
        }
      } catch (error) {
        taggedEmit({ type: "error", runId, error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }

      // Stream tool calls and execute tools if executors are provided
      if (tools) {
        const toolCalls: ToolCall[] = [];
        try {
          for await (const toolCall of result.getToolCallsStream()) {
            taggedEmit({
              type: "tool_call",
              runId,
              name: toolCall.name,
              id: toolCall.id,
              input: toolCall.arguments,
            });
            toolCalls.push({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments });
          }
        } catch {
          // No tool calls or error - that's ok
        }

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
            const { context: toolContext, result: toolResult } = await toolDef.execute(tc.arguments, toolCtx);
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
