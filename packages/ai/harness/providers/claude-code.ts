import { v7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
} from "../../types";
import { log } from "../../logger";

/**
 * Separate system message from conversation and serialize remaining
 * messages into a prompt string with XML role markers.
 */
export function serializeMessages(messages: Message[]): {
  systemPrompt: string | undefined;
  prompt: string;
} {
  let systemPrompt: string | undefined;
  const nonSystem: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else {
      nonSystem.push(msg);
    }
  }

  // Single user message — pass through directly
  if (nonSystem.length === 1 && nonSystem[0]!.role === "user") {
    const content = nonSystem[0]!.content;
    return {
      systemPrompt,
      prompt: typeof content === "string" ? content : JSON.stringify(content),
    };
  }

  // Multi-turn — wrap each message in XML role tags
  const parts: string[] = [];
  for (const msg of nonSystem) {
    const content =
      msg.role === "assistant"
        ? (msg.content ?? "")
        : typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
    parts.push(`<${msg.role}>\n${content}\n</${msg.role}>`);
  }

  return { systemPrompt, prompt: parts.join("\n\n") };
}

/**
 * Parse newline-delimited JSON from a ReadableStream.
 * Skips empty lines and malformed JSON (same resilience as Zen's SSE parser).
 */
export async function* parseNDJSON(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
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
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          continue; // skip malformed lines
        }
      }
    }

    // Handle any remaining content in buffer
    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface MapContext {
  runId: string;
  textId: string;
  reasoningId: string;
  parentId?: string;
}

/**
 * Map a raw Claude API stream event to a HarnessEvent, or null if ignored.
 */
export function mapStreamEvent(event: Record<string, any>, ctx: MapContext): HarnessEvent | null {
  if (event.type !== "content_block_delta") return null;

  const delta = event.delta;
  if (!delta) return null;

  const tag = <T extends object>(e: T): T & { parentId?: string } =>
    ctx.parentId ? { ...e, parentId: ctx.parentId } : e;

  if (delta.type === "text_delta" && delta.text) {
    return tag({ type: "text" as const, runId: ctx.runId, id: ctx.textId, content: delta.text });
  }

  if (delta.type === "thinking_delta" && delta.thinking) {
    return tag({
      type: "reasoning" as const,
      runId: ctx.runId,
      id: ctx.reasoningId,
      content: delta.thinking,
    });
  }

  return null;
}

interface ClaudeCodeHarnessOptions {
  model?: string;
  cliPath?: string;
}

function createGeneratorHarness(options?: ClaudeCodeHarnessOptions): GeneratorHarnessModule {
  const defaultModel = options?.model;
  const cliPath = options?.cliPath ?? "claude";

  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const runId = v7();
      const model = params.model ?? defaultModel;
      if (!model) {
        yield {
          type: "error" as const,
          runId,
          error: new Error("No model specified: provide model at harness creation or invoke time"),
        };
        return;
      }
      const parentId = params.env?.parentId;
      const textId = v7();
      const reasoningId = v7();

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      const { systemPrompt, prompt } = serializeMessages(params.messages);

      const args = [
        cliPath,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        model,
      ];

      if (systemPrompt) {
        args.push("--system-prompt", systemPrompt);
      }

      // Disable all built-in tools
      args.push("--allowedTools", "");

      log("I", runId, "api_req", `model=${model} provider=claude-code`);

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        // Unset CLAUDECODE to allow spawning claude inside a Claude Code session
        const env = { ...process.env };
        delete env.CLAUDECODE;
        proc = Bun.spawn(args, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
      } catch (error) {
        log("E", runId, "api_err", `spawn failed: ${error}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      // Write prompt to stdin and close
      const stdin = proc.stdin as import("bun").FileSink;
      try {
        stdin.write(prompt);
        stdin.end();
      } catch (error) {
        log("E", runId, "api_err", `stdin write failed: ${error}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      // Consume stderr in parallel so it's available for error reporting
      const stderrPromise = new Response(proc.stderr as ReadableStream).text().catch(() => "");

      const streamStart = Date.now();
      log("I", runId, "stream_start");

      let gotResponse = false;
      let usageYielded = false;
      const mapCtx: MapContext = { runId, textId, reasoningId, parentId };

      try {
        for await (const obj of parseNDJSON(proc.stdout as ReadableStream<Uint8Array>)) {
          const line = obj as Record<string, any>;

          // Stream events contain raw Claude API events
          if (line.type === "stream_event" && line.event) {
            const mapped = mapStreamEvent(line.event, mapCtx);
            if (mapped) {
              gotResponse = true;
              yield mapped;
            }

            // Extract usage from message_delta
            if (line.event.type === "message_delta" && line.event.usage) {
              const u = line.event.usage;
              if (u.output_tokens) {
                yield tag({
                  type: "usage" as const,
                  runId,
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                });
                usageYielded = true;
              }
            }
          }

          // CLI v2.x emits "assistant" events with the full message
          if (line.type === "assistant" && line.message?.content) {
            for (const block of line.message.content) {
              if (block.type === "text" && block.text) {
                gotResponse = true;
                yield tag({
                  type: "text" as const,
                  runId,
                  id: textId,
                  content: block.text,
                });
              }
            }
            // Extract usage from assistant message
            if (line.message.usage && !usageYielded) {
              const u = line.message.usage;
              if (u.output_tokens) {
                yield tag({
                  type: "usage" as const,
                  runId,
                  inputTokens: u.input_tokens ?? 0,
                  outputTokens: u.output_tokens ?? 0,
                });
                usageYielded = true;
              }
            }
          }

          // ResultMessage — fallback usage source
          if (line.type === "result" && !usageYielded) {
            const u = line.usage;
            if (u) {
              yield tag({
                type: "usage" as const,
                runId,
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
              });
              usageYielded = true;
            }
          }
        }
      } catch (error) {
        log("E", runId, "api_err", `stream error: ${error}`);
        yield tag({
          type: "error" as const,
          runId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      log("I", runId, "stream_end", `dur=${Date.now() - streamStart}ms`);

      // Wait for process to finish
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await stderrPromise;
        yield tag({
          type: "error" as const,
          runId,
          error: new Error(`claude process exited with code ${exitCode}: ${stderr}`.trim()),
        });
        return;
      }

      if (!gotResponse) {
        yield tag({
          type: "error" as const,
          runId,
          error: new Error("No response from Claude Code CLI"),
        });
      }
    },

    async supportedModels(): Promise<string[]> {
      return ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
    },
  };
}

export { createGeneratorHarness };
