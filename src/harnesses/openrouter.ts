import { OpenRouter, tool } from "@openrouter/sdk";
import type { z } from "zod";
import {v7} from "uuid";
import type { HarnessModule, InvokeParams, Message, ToolDefinition } from "../types";

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
    async invoke({ emit, runId: providedRunId, ...params }: InvokeParams): Promise<void> {
      const input = convertMessages(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const runId = providedRunId ?? v7();
      const reasoningId = v7();
      const textId = v7();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = client.callModel({
        model: params.model,
        input,
        ...(tools && { tools }),
      } as any);

      // Stream reasoning (for o1 and similar models)
      try {
        for await (const delta of result.getReasoningStream()) {
          emit({ type: "reasoning", runId, id: reasoningId, content: delta });
        }
      } catch {
        // Model may not support reasoning - that's ok
      }

      // Stream text
      try {
        for await (const delta of result.getTextStream()) {
          emit({ type: "text", runId, id: textId, content: delta });
        }
      } catch (error) {
        emit({ type: "error", runId, error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }

      // Stream tool calls if tools were provided
      if (tools) {
        try {
          for await (const toolCall of result.getToolCallsStream()) {
            emit({
              type: "tool_call",
              runId,
              name: toolCall.name,
              id: toolCall.id,
              input: toolCall.arguments,
            });
          }
        } catch {
          // No tool calls or error - that's ok
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
