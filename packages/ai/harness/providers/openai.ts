import OpenAI from "openai";
import { v7 } from "uuid";
import { toJSONSchema } from "zod";
import type {
  ContentPart,
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  ToolDefinition,
} from "../../types";

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

function contentPartsToOpenAI(parts: ContentPart[]) {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "input_text" as const, text: part.text };
    } else if (part.type === "image") {
      return {
        type: "input_image" as const,
        image_url: `data:${part.mediaType};base64,${part.data}`,
      };
    } else {
      // document (PDF)
      return {
        type: "input_file" as const,
        file_data: `data:${part.mediaType};base64,${part.data}`,
      };
    }
  });
}

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
      if (Array.isArray(msg.content)) {
        input.push({
          role: "user",
          content: contentPartsToOpenAI(msg.content),
          type: "message",
        } as ResponseInputItem);
      } else {
        input.push({
          role: "user",
          content: msg.content,
          type: "message",
        });
      }
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
              typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
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
        output: Array.isArray(msg.content) ? JSON.stringify(msg.content) : msg.content,
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
    parameters: toJSONSchema(t.schema) as unknown as Record<string, unknown>,
    strict: true,
  }));
}

/**
 * Single-iteration OpenAI harness using the Responses API with SSE streaming.
 *
 * This harness makes a single LLM call and yields events for:
 * - reasoning: streamed reasoning content
 * - text: streamed text content
 * - tool_call: tool calls from the model
 * - error: any errors that occur
 *
 * It does NOT:
 * - Execute tools (that's the agent wrapper's job)
 * - Handle permissions (that's the agent wrapper's job)
 * - Loop after tool calls (that's the agent wrapper's job)
 */
interface OpenAIHarnessOptions {
  apiKey?: string;
  model?: string;
}

function createGeneratorHarness(
  apiKeyOrOptions?: string | OpenAIHarnessOptions,
): GeneratorHarnessModule {
  const opts = typeof apiKeyOrOptions === "string" ? { apiKey: apiKeyOrOptions } : apiKeyOrOptions;
  const client = new OpenAI({
    apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY,
  });
  const defaultModel = opts?.model;

  return {
    async *invoke({ env, ...params }: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const model = params.model ?? defaultModel;
      if (!model) {
        throw new Error("No model specified: provide model at harness creation or invoke time");
      }

      const runId = v7();
      const parentId = env?.parentId;
      const reasoningId = v7();
      const textId = v7();

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const { instructions, input } = convertMessages(params.messages);
      const tools = params.tools ? convertTools(params.tools) : undefined;

      try {
        const stream = await client.responses.create({
          model,
          instructions,
          input,
          ...(tools && tools.length > 0 && { tools }),
          stream: true,
        });

        // Track tool calls by output_index
        const toolCallsMap: Record<
          string,
          { id: string; callId: string; name: string; arguments: string }
        > = {};

        for await (const event of stream) {
          // Reasoning text delta events
          if (event.type === "response.reasoning_text.delta") {
            yield tag({
              type: "reasoning" as const,
              runId,
              id: reasoningId,
              content: event.delta,
            });
          }

          // Text content delta events
          if (event.type === "response.output_text.delta") {
            yield tag({
              type: "text" as const,
              runId,
              id: textId,
              content: event.delta,
            });
          }

          // Function call - when a new function call output item is added
          if (event.type === "response.output_item.added") {
            const item = event.item;
            if (item.type === "function_call") {
              const key = String(event.output_index);
              toolCallsMap[key] = {
                id: item.id || v7(),
                callId: item.call_id || "",
                name: item.name || "",
                arguments: item.arguments || "",
              };
            }
          }

          // Function call arguments delta
          if (event.type === "response.function_call_arguments.delta") {
            const key = String(event.output_index);
            if (toolCallsMap[key]) {
              toolCallsMap[key].arguments += event.delta;
            }
          }

          // Function call arguments done
          if (event.type === "response.function_call_arguments.done") {
            const key = String(event.output_index);
            if (toolCallsMap[key]) {
              toolCallsMap[key].arguments = event.arguments;
            }
          }

          // Output item done
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

        // Yield tool_call events for the agent wrapper to process
        for (const tc of Object.values(toolCallsMap)) {
          let args: unknown;
          try {
            args = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch (e) {
            args = {
              __toolParseError: true,
              parseError: e instanceof Error ? e.message : String(e),
              rawArguments: tc.arguments,
            };
          }
          yield tag({
            type: "tool_call" as const,
            runId,
            name: tc.name,
            id: tc.callId || tc.id,
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
      const response = await client.models.list();
      const chatModels = [];
      for await (const model of response) {
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

export const openAiHarness = createGeneratorHarness();
export { createGeneratorHarness };
