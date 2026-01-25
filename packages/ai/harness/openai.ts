import OpenAI from "openai";
import { v7 } from "uuid";
import type {
  HarnessModule,
  InvokeParams,
  Message,
  ToolDefinition,
  ToolContext,
  ToolCall,
} from "../types";

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

/**
 * Convert our Message[] format to OpenAI Responses API input format.
 * The Responses API uses a different structure than Chat Completions:
 * - System messages become the `instructions` parameter (returned separately)
 * - User messages are { role: 'user', content: string, type: 'message' }
 * - Assistant messages with tool calls become ResponseFunctionToolCall items
 * - Tool results become { type: 'function_call_output', call_id: string, output: string }
 */
function convertMessages(messages: Message[]): {
  instructions: string | undefined;
  input: ResponseInputItem[];
} {
  let instructions: string | undefined;
  const input: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Accumulate system messages into instructions
      instructions = instructions ? `${instructions}\n\n${msg.content}` : msg.content;
    } else if (msg.role === "user") {
      input.push({
        role: "user",
        content: msg.content,
        type: "message",
      });
    } else if (msg.role === "assistant") {
      // If the assistant has tool_calls, we need to add those as separate items
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // First add the text content as a message if present
        if (msg.content) {
          input.push({
            role: "assistant",
            content: msg.content,
            type: "message",
          } as ResponseInputItem);
        }
        // Then add each tool call as a function_call item
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments:
              typeof tc.arguments === "string"
                ? tc.arguments
                : JSON.stringify(tc.arguments ?? {}),
          });
        }
      } else if (msg.content) {
        // Just text content from assistant
        input.push({
          role: "assistant",
          content: msg.content,
          type: "message",
        } as ResponseInputItem);
      }
    } else if (msg.role === "tool") {
      // Tool results become function_call_output items
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: msg.content,
      });
    }
  }

  return { instructions, input };
}

/**
 * Convert our ToolDefinition[] to OpenAI Responses API tools format.
 */
function convertTools(tools: ToolDefinition[]): OpenAI.Responses.Tool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.schema as unknown as Record<string, unknown>,
    strict: true,
  }));
}

/**
 * Track tool calls being accumulated from streaming events.
 */
interface StreamingToolCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

function createHarness(apiKey?: string): HarnessModule {
  const client = new OpenAI({
    apiKey: apiKey ?? process.env.OPENAI_API_KEY,
  });

  return {
    async invoke({ emit, runId: providedRunId, context, ...params }: InvokeParams): Promise<void> {
      const { instructions, input } = convertMessages(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      const runId = providedRunId ?? v7();
      const parentId = context?.parentId;
      const reasoningId = v7();
      const textId = v7();

      // Wrap emit to add parentId to events
      const taggedEmit = (event: Parameters<typeof emit>[0]) => {
        emit(parentId ? { ...event, parentId } : event);
      };

      try {
        // Use the Responses API with streaming
        const stream = await client.responses.create({
          model: params.model,
          instructions,
          input,
          ...(tools && tools.length > 0 && { tools }),
          stream: true,
        });

        // Track accumulated tool calls by output_index
        const toolCallsMap: Record<string, StreamingToolCall> = {};
        // Track current output item indices for mapping
        let currentOutputIndex = 0;

        for await (const event of stream) {
          // Handle different event types from the Responses API

          // Reasoning text delta events
          if (event.type === "response.reasoning_text.delta") {
            taggedEmit({
              type: "reasoning",
              runId,
              id: reasoningId,
              content: event.delta,
            });
          }

          // Text content delta events
          if (event.type === "response.output_text.delta") {
            taggedEmit({
              type: "text",
              runId,
              id: textId,
              content: event.delta,
            });
          }

          // Function call - when a new function call output item is added
          if (event.type === "response.output_item.added") {
            const item = event.item;
            if (item.type === "function_call") {
              currentOutputIndex = event.output_index;
              const key = String(event.output_index);
              toolCallsMap[key] = {
                id: item.id || v7(),
                callId: item.call_id || "",
                name: item.name || "",
                arguments: item.arguments || "",
              };
            }
          }

          // Function call arguments delta - accumulate arguments as they stream
          if (event.type === "response.function_call_arguments.delta") {
            const key = String(event.output_index);
            if (toolCallsMap[key]) {
              toolCallsMap[key].arguments += event.delta;
            }
          }

          // Function call arguments done - arguments are complete
          if (event.type === "response.function_call_arguments.done") {
            const key = String(event.output_index);
            if (toolCallsMap[key]) {
              toolCallsMap[key].arguments = event.arguments;
            }
          }

          // Output item done - could be a completed function call
          if (event.type === "response.output_item.done") {
            const item = event.item;
            if (item.type === "function_call") {
              const key = String(event.output_index);
              if (toolCallsMap[key]) {
                toolCallsMap[key].callId = item.call_id;
                toolCallsMap[key].name = item.name;
                toolCallsMap[key].arguments = item.arguments;
              }
            }
          }
        }

        // After streaming completes, emit tool calls and execute tools
        const toolCalls: ToolCall[] = Object.values(toolCallsMap).map((tc) => {
          let parsedArgs: unknown;
          try {
            parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            parsedArgs = tc.arguments;
          }

          return {
            id: tc.callId || tc.id,
            name: tc.name,
            arguments: parsedArgs,
          };
        });

        // Emit tool_call events
        for (const tc of toolCalls) {
          taggedEmit({
            type: "tool_call",
            runId,
            name: tc.name,
            id: tc.id,
            input: tc.arguments,
          });
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
      const response = await client.models.list();
      // Filter to only chat/completion models (exclude embedding, tts, etc.)
      const chatModels = [];
      for await (const model of response) {
        // Include models that are likely to support the Responses API
        if (
          model.id.includes("gpt") ||
          model.id.includes("o1") ||
          model.id.includes("o3") ||
          model.id.includes("chatgpt")
        ) {
          chatModels.push(model.id);
        }
      }
      return chatModels;
    },
  };
}

export const openAiHarness = createHarness();
export { createHarness };
