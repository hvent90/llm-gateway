import { v7 as uuidv7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
} from "../types";
import type { RlmConfig } from "./types";
import { createRepl } from "./repl";
import { buildRlmSystemPrompt } from "./system-prompt";
import { execShell } from "../tools/lib/shell";

interface RlmHarnessOptions {
  /** Provider harness for root LLM calls */
  rootHarness: GeneratorHarnessModule;
  /** Provider harness for sub LLM calls (llm_query in REPL). Defaults to rootHarness. */
  subHarness?: GeneratorHarnessModule;
  /** RLM configuration */
  config: RlmConfig;
}

/** Extract code from a model response. Looks for fenced JS blocks, falls back to entire text. */
function extractCode(text: string): string {
  const fenceRe = /```(?:js|javascript)\n([\s\S]*?)```/;
  const match = fenceRe.exec(text);
  if (match?.[1]) return match[1].trim();
  return text.trim();
}

/** Collect all text from a provider harness invocation. */
async function collectText(
  iterable: AsyncIterable<HarnessEvent>,
): Promise<{ text: string; events: HarnessEvent[] }> {
  let text = "";
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (event.type === "text") text += event.content;
  }
  return { text, events };
}

function createRlmHarness(options: RlmHarnessOptions): GeneratorHarnessModule {
  const { rootHarness, config } = options;
  const subHarness = options.subHarness ?? rootHarness;

  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const runId = uuidv7();
      const parentId = params.context?.parentId;

      const tag = <T extends { runId: string }>(event: T): T & { parentId?: string } => {
        const tagged = { ...event, runId };
        if (parentId) (tagged as T & { parentId?: string }).parentId = parentId;
        else delete (tagged as T & { parentId?: string }).parentId;
        return tagged;
      };

      yield tag({ type: "harness_start", runId });

      // Find the user prompt — last user message
      const userMessage = [...params.messages].reverse().find((m) => m.role === "user");
      const userPrompt =
        typeof userMessage?.content === "string"
          ? userMessage.content
          : ((userMessage?.content?.find((p) => p.type === "text") as { text: string } | undefined)
              ?.text ?? "");

      // llm_query callback: send a prompt to the sub-harness
      const llmQuery = async (prompt: string): Promise<string> => {
        const { text } = await collectText(
          subHarness.invoke({
            model: config.subModel,
            messages: [{ role: "user", content: prompt }],
          }),
        );
        return text;
      };

      // exec callback: run a shell command with configurable timeout
      const exec = (command: string, timeout?: number) =>
        execShell({ command, timeout: timeout ?? config.execTimeout ?? 10 });

      // Create the REPL with prompt as context
      const repl = createRepl({
        context: userPrompt,
        llmQuery,
        subRlm: llmQuery, // v1: sub_rlm delegates to llm_query
        exec,
        maxStdoutLength: config.maxStdoutLength,
      });

      // Build system prompt with metadata only
      const systemPrompt = buildRlmSystemPrompt({
        contextLength: userPrompt.length,
        contextPrefix: userPrompt.slice(0, config.metadataPrefixLength),
      });

      // Internal message history for the RLM loop
      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      // RLM loop
      for (let i = 0; i < config.maxIterations; i++) {
        // Call root LLM
        const { text: responseText, events } = await collectText(
          rootHarness.invoke({
            model: params.model,
            messages,
          }),
        );

        // Pass through usage events
        for (const event of events) {
          if (event.type === "usage") yield tag(event);
        }

        // Extract code from model response
        const code = extractCode(responseText);

        // Yield tool_call for the REPL execution
        const callId = uuidv7();
        yield tag({
          type: "tool_call",
          runId,
          id: callId,
          name: "repl_execute",
          input: { code },
        });

        // Execute in REPL
        const result = await repl.execute(code);

        // Build output for tool_result
        const output = result.error
          ? { error: result.error, stdout: result.stdout }
          : { stdout: result.stdout };

        yield tag({
          type: "tool_result",
          runId,
          id: callId,
          name: "repl_execute",
          output,
        });

        // Append to internal message history
        messages.push({ role: "assistant", content: responseText });

        const feedbackParts: string[] = [];
        if (result.stdout) feedbackParts.push(`stdout:\n${result.stdout}`);
        if (result.error) feedbackParts.push(`error: ${result.error}`);
        if (feedbackParts.length === 0) feedbackParts.push("(no output)");
        messages.push({ role: "user", content: feedbackParts.join("\n") });

        // Check if done
        if (result.done && result.finalValue !== undefined) {
          yield tag({
            type: "text",
            runId,
            id: uuidv7(),
            content: result.finalValue,
          });
          break;
        }
      }

      yield tag({ type: "harness_end", runId });
    },

    supportedModels: () => rootHarness.supportedModels(),
  };
}

export { createRlmHarness };
export type { RlmHarnessOptions };
