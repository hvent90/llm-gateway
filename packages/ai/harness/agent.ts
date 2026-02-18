import { v7 as uuidv7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  PermissionResponse,
  ToolCall,
  ToolContext,
  ToolDefinition,
} from "../types";
import { matchesPermissions } from "../permissions";
import { deferred } from "../primitives";
import { log } from "../logger";

interface AgentHarnessOptions {
  harness: GeneratorHarnessModule;
  maxIterations?: number;
  model?: string;
}

/**
 * Creates an agent harness that wraps a single-iteration provider harness.
 *
 * The agent harness provides:
 * - Agentic loop: continues calling LLM until no tool calls or maxIterations reached
 * - Permission handling: checks allowlist, yields permission_required events, waits for respond()
 * - Tool execution: executes tools with proper context, yields tool_result events
 * - Message history: builds up messages array with assistant responses and tool results
 */
function createAgentHarness(options: AgentHarnessOptions): GeneratorHarnessModule {
  const { harness, maxIterations = 10, model: defaultModel } = options;

  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const model = params.model ?? defaultModel;
      if (!model) {
        throw new Error("No model specified: provide model at harness creation or invoke time");
      }
      const myRunId = uuidv7();
      const nsId = (rawId: string) => `${myRunId}/${rawId}`;
      const parentId = params.env?.parentId;

      const tag = <T extends { runId: string }>(event: T): T & { parentId?: string } => {
        const tagged = { ...event, runId: myRunId };
        if (parentId) (tagged as T & { parentId?: string }).parentId = parentId;
        else delete (tagged as T & { parentId?: string }).parentId;
        return tagged;
      };

      yield tag({ type: "harness_start", runId: myRunId });

      // Mutable messages array for the agent loop
      const messages: Message[] = [...params.messages];
      let iterations = 0;
      let assistantText = "";
      let lastHadToolCalls = false;

      while (iterations++ < maxIterations + 1) {
        const isSummarizing = iterations > maxIterations;

        if (isSummarizing && !lastHadToolCalls) break;

        if (isSummarizing) {
          messages.push({
            role: "system",
            content:
              "You have reached the maximum number of tool call iterations. " +
              "Summarize your progress and provide your final response.",
          });
        }

        log("I", myRunId, "loop_iter", `iter=${iterations} max=${maxIterations}`);

        const toolCalls: ToolCall[] = [];
        assistantText = "";

        // Single iteration - collect events from provider harness
        const llmStart = Date.now();
        log("I", myRunId, "llm_call_start", `model=${model}`);
        for await (const event of harness.invoke({
          ...params,
          model,
          messages,
          tools: isSummarizing ? [] : params.tools,
          env: { parentId: myRunId },
        })) {
          // Pass through provider events untouched — they carry
          // the provider's own runId and parentId (true provenance)
          if (event.type === "text") {
            yield event;
            assistantText += event.content;
          } else if (event.type === "reasoning") {
            yield event;
          } else if (event.type === "usage") {
            yield event;
          } else if (event.type === "error") {
            yield event;
            yield tag({ type: "harness_end", runId: myRunId });
            return assistantText; // Stop on error
          } else if (event.type === "tool_call") {
            // Collect tool calls for processing after iteration
            toolCalls.push({
              id: event.id,
              name: event.name,
              arguments: event.input as Record<string, unknown>,
            });
          }
          // Note: provider harness should not emit tool_result or permission_required
          // Those are handled by this agent wrapper
        }
        log(
          "I",
          myRunId,
          "llm_call_end",
          `dur=${Date.now() - llmStart}ms tools=${toolCalls.length}`,
        );

        // No tool calls - we're done
        if (toolCalls.length === 0) {
          log("I", myRunId, "no_tools");
          yield tag({ type: "harness_end", runId: myRunId });
          return assistantText;
        }

        // Add assistant message with tool calls to history
        messages.push({
          role: "assistant",
          content: assistantText || null,
          tool_calls: toolCalls,
        });

        // Pass 1: permissions (sequential — must yield relays)
        const approved: Array<{ tc: ToolCall; toolDef: ToolDefinition }> = [];
        let earlyReturn = false;

        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);
          const args = (tc.arguments ?? {}) as Record<string, unknown>;

          // Check deny list first
          const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
          if (denial) {
            const output = { status: "denied", reason: denial.reason };
            yield tag({
              type: "tool_result",
              runId: myRunId,
              id: nsId(tc.id),
              name: tc.name,
              output,
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(output),
            });
            continue;
          }

          // Check if allowed (allowlist or allowOnce)
          const isAllowed =
            params.permissions &&
            matchesPermissions({ name: tc.name, arguments: args }, params.permissions);

          if (!isAllowed) {
            log("I", myRunId, "perm_check", `tool=${tc.name}`);
            // Need permission - create deferred and yield permission_required
            const { promise, resolve } = deferred<PermissionResponse>();
            yield tag({
              type: "relay",
              kind: "permission",
              runId: myRunId,
              id: uuidv7(),
              toolCallId: nsId(tc.id),
              tool: tc.name,
              params: args,
              respond: (response: PermissionResponse) => resolve(response),
            });

            // Generator pauses here until respond() is called
            const permStart = Date.now();
            log("I", myRunId, "perm_wait", `tool=${tc.name} toolCallId=${nsId(tc.id)}`);
            const decision = await promise;
            log(
              "I",
              myRunId,
              "perm_resolved",
              `tool=${tc.name} approved=${decision.approved} waited=${Date.now() - permStart}ms`,
            );

            if (!decision.approved) {
              const output = { status: "denied", reason: decision.reason };
              yield tag({
                type: "tool_result",
                runId: myRunId,
                id: nsId(tc.id),
                name: tc.name,
                output,
              });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(output),
              });
              continue;
            }
          }

          // Approved — yield tool_call event
          yield tag({
            type: "tool_call",
            runId: myRunId,
            name: tc.name,
            id: nsId(tc.id),
            input: args,
          });

          // Check for malformed tool arguments (truncated JSON from model)
          if (args && typeof args === "object" && "__toolParseError" in args) {
            const { parseError, rawArguments } = args as {
              parseError?: string;
              rawArguments?: string;
            };
            const output = {
              error: `Tool call had malformed arguments. Parse error: ${parseError ?? "unknown"}. Raw arguments: ${rawArguments ?? ""}`,
            };
            yield tag({
              type: "tool_result",
              runId: myRunId,
              id: nsId(tc.id),
              name: tc.name,
              output,
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(output),
            });
            continue;
          }

          if (!toolDef?.execute) {
            // No executor - yield error and return
            yield tag({
              type: "error",
              runId: myRunId,
              error: new Error(`No executor for tool: ${tc.name}`),
            });
            earlyReturn = true;
            break;
          }

          approved.push({ tc, toolDef: toolDef as ToolDefinition });
        }

        if (earlyReturn) {
          yield tag({ type: "harness_end", runId: myRunId });
          return assistantText;
        }

        // Pass 2: execute approved tools concurrently
        const execStart = Date.now();
        log("I", myRunId, "tool_exec_start", `count=${approved.length}`);
        const results = await Promise.all(
          approved.map(async ({ tc, toolDef }) => {
            const toolCtx: ToolContext = {
              parentId: nsId(tc.id),
              spawn: params.env?.spawn
                ? (task: string) => params.env!.spawn!(task, nsId(tc.id))
                : undefined,
              fileTime: params.env?.fileTime,
            };
            try {
              const { context: toolContext, result: toolResult } = await toolDef.execute!(
                tc.arguments,
                toolCtx,
              );
              const output = { context: toolContext, result: toolResult };
              return {
                event: tag({
                  type: "tool_result" as const,
                  runId: myRunId,
                  name: tc.name,
                  id: nsId(tc.id),
                  output,
                }),
                message: {
                  role: "tool" as const,
                  tool_call_id: tc.id,
                  content: toolContext ?? JSON.stringify(output),
                },
              };
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              return {
                event: tag({
                  type: "error" as const,
                  runId: myRunId,
                  error: error instanceof Error ? error : new Error(errorMsg),
                }),
                message: {
                  role: "tool" as const,
                  tool_call_id: tc.id,
                  content: JSON.stringify({ error: errorMsg }),
                },
              };
            }
          }),
        );

        log("I", myRunId, "tool_exec_end", `dur=${Date.now() - execStart}ms`);

        // Yield results and add to messages
        for (const { event, message } of results) {
          yield event;
          messages.push(message);
        }

        lastHadToolCalls = toolCalls.length > 0;

        // Loop continues - will call LLM again with tool results
      }

      log("W", myRunId, "max_iter", `iter=${iterations - 1}`);
      yield tag({ type: "harness_end", runId: myRunId });
      return assistantText;
    },

    supportedModels: () => harness.supportedModels(),
  };
}

export { createAgentHarness };
export type { AgentHarnessOptions };
