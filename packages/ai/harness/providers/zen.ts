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
import { log } from "../../logger";

const BASE_URL = "https://opencode.ai/zen/v1";

function contentPartsToZen(parts: ContentPart[]) {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    } else if (part.type === "image") {
      return {
        type: "image_url" as const,
        image_url: { url: `data:${part.mediaType};base64,${part.data}` },
      };
    } else {
      // document (PDF) — fallback since Chat Completions doesn't support PDF natively
      return { type: "text" as const, text: "[PDF document]" };
    }
  });
}

/**
 * Convert our Message[] format to OpenAI Chat Completions format.
 */
function convertMessages(messages: Message[]) {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: msg.tool_call_id,
        content: Array.isArray(msg.content) ? JSON.stringify(msg.content) : msg.content,
      };
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        role: "assistant" as const,
        content: msg.content,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
          },
        })),
      };
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return { role: "user" as const, content: contentPartsToZen(msg.content) };
    }
    return { role: msg.role, content: msg.content };
  });
}

/**
 * Convert our ToolDefinition[] to OpenAI Chat Completions tools format.
 */
function convertTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: toJSONSchema(t.schema),
    },
  }));
}

/**
 * Parse SSE lines from a ReadableStream of bytes.
 */
async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface ChatCompletionChunkDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface ChatCompletionChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { message: string };
}

/**
 * Single-iteration Zen harness using OpenAI Chat Completions SSE streaming.
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
interface ZenHarnessOptions {
  apiKey?: string;
  model?: string;
}

function createGeneratorHarness(
  apiKeyOrOptions?: string | ZenHarnessOptions,
): GeneratorHarnessModule {
  const opts = typeof apiKeyOrOptions === "string" ? { apiKey: apiKeyOrOptions } : apiKeyOrOptions;
  const key = opts?.apiKey ?? process.env.ZEN_API_KEY;
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

      const body: Record<string, unknown> = {
        model,
        messages: convertMessages(params.messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (params.tools?.length) {
        body.tools = convertTools(params.tools);
      }

      let response: Response;
      log("I", runId, "api_req", `model=${model}`);
      try {
        response = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        log("E", runId, "api_err", `msg=${error instanceof Error ? error.message : String(error)}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      log("I", runId, "api_res", `status=${response.status}`);

      if (!response.ok) {
        let message = `Zen API returned ${response.status}`;
        try {
          const errorBody = await response.text();
          message += `: ${errorBody}`;
        } catch {}
        yield tag({ type: "error" as const, runId, error: new Error(message) });
        return;
      }

      if (!response.body) {
        yield tag({ type: "error" as const, runId, error: new Error("No response body") });
        return;
      }

      // Accumulate tool calls by index as they stream in
      const toolCallsMap: Record<number, { id: string; name: string; arguments: string }> = {};
      let usageData: ChatCompletionChunk["usage"] | undefined;

      const streamStart = Date.now();
      log("I", runId, "stream_start");
      try {
        for await (const data of parseSSE(response.body)) {
          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // skip malformed chunks
          }

          if (chunk.error) {
            yield tag({
              type: "error" as const,
              runId,
              error: new Error(chunk.error.message),
            });
            return;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Reasoning content
          if (delta.reasoning_content) {
            yield tag({
              type: "reasoning" as const,
              runId,
              id: reasoningId,
              content: delta.reasoning_content,
            });
          }

          // Text content
          if (delta.content) {
            yield tag({ type: "text" as const, runId, id: textId, content: delta.content });
          }

          // Tool calls (streamed incrementally by index)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallsMap[idx]) {
                toolCallsMap[idx] = { id: tc.id ?? "", name: "", arguments: "" };
              }
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
            }
          }

          // Usage (sent in the final chunk when stream_options.include_usage is true)
          if (chunk.usage) {
            usageData = chunk.usage;
          }
        }
      } catch (error) {
        log("E", runId, "api_err", `msg=${error instanceof Error ? error.message : String(error)}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }
      log("I", runId, "stream_end", `dur=${Date.now() - streamStart}ms`);

      // Yield tool_call events for the agent wrapper to process
      for (const tc of Object.values(toolCallsMap)) {
        let args: unknown;
        try {
          args = JSON.parse(tc.arguments);
        } catch (e) {
          log("W", runId, "tool_parse_err", `tool=${tc.name} args=${tc.arguments}`);
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
          id: tc.id,
          input: args,
        });
      }

      // Emit usage event after streaming completes
      if (usageData) {
        yield tag({
          type: "usage" as const,
          runId,
          inputTokens: usageData.prompt_tokens,
          outputTokens: usageData.completion_tokens,
          cacheReadTokens:
            usageData.prompt_tokens_details?.cached_tokens ?? usageData.cache_read_input_tokens,
          cacheCreationTokens: usageData.cache_creation_input_tokens,
        });
      }
    },

    async supportedModels(): Promise<string[]> {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!response.ok) {
        throw new Error(`Zen models endpoint returned ${response.status}`);
      }
      const json = (await response.json()) as { data: Array<{ id: string }> };
      return json.data.map((m) => m.id);
    },
  };
}

export const zenHarness = createGeneratorHarness();
export { createGeneratorHarness };
