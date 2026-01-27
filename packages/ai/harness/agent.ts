import { v7 as uuidv7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  PermissionResponse,
  ToolCall,
  ToolContext,
} from "../types";
import { matchesPermissions } from "../permissions";
import { deferred } from "../primitives";

interface AgentHarnessOptions {
  harness: GeneratorHarnessModule;
  maxIterations?: number;
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
  const { harness, maxIterations = 10 } = options;

  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const myRunId = uuidv7();
      const parentId = params.context?.parentId;

      const tag = <T extends object>(event: T): T & { parentId?: string } =>
        parentId ? { ...event, parentId } : event;

      // Mutable messages array for the agent loop
      const messages: Message[] = [...params.messages];
      let iterations = 0;

      while (iterations++ < maxIterations) {
        const toolCalls: ToolCall[] = [];
        let assistantText = "";

        // Single iteration - collect events from provider harness
        for await (const event of harness.invoke({
          ...params,
          messages,
          context: { parentId: myRunId },
        })) {
          // Pass through text, reasoning, and error events
          if (event.type === "text") {
            yield tag(event);
            assistantText += event.content;
          } else if (event.type === "reasoning") {
            yield tag(event);
          } else if (event.type === "error") {
            yield tag(event);
            return; // Stop on error
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

        // No tool calls - we're done
        if (toolCalls.length === 0) {
          return;
        }

        // Add assistant message with tool calls to history
        messages.push({
          role: "assistant",
          content: assistantText || null,
          tool_calls: toolCalls,
        });

        // Process each tool call
        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);
          const args = (tc.arguments ?? {}) as Record<string, unknown>;

          // Check deny list first
          const denial = params.permissions?.deny?.find((d) => d.toolCallId === tc.id);
          if (denial) {
            const output = { status: "denied", reason: denial.reason };
            yield tag({ type: "tool_result", runId: myRunId, id: tc.id, name: tc.name, output });
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
            // Need permission - create deferred and yield permission_required
            const { promise, resolve } = deferred<PermissionResponse>();
            yield tag({
              type: "relay",
              kind: "permission",
              runId: myRunId,
              id: uuidv7(),
              toolCallId: tc.id,
              tool: tc.name,
              params: args,
              respond: (response: PermissionResponse) => resolve(response),
            });

            // Generator pauses here until respond() is called
            const decision = await promise;

            if (!decision.approved) {
              const output = { status: "denied", reason: decision.reason };
              yield tag({ type: "tool_result", runId: myRunId, id: tc.id, name: tc.name, output });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(output),
              });
              continue;
            }
          }

          // Permission granted or in allowlist - yield tool_call and execute
          yield tag({ type: "tool_call", runId: myRunId, name: tc.name, id: tc.id, input: args });

          if (!toolDef?.execute) {
            // No executor - yield error and return
            yield tag({
              type: "error",
              runId: myRunId,
              error: new Error(`No executor for tool: ${tc.name}`),
            });
            return;
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
            yield tag({ type: "tool_result", runId: myRunId, name: tc.name, id: tc.id, output });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: toolContext ?? JSON.stringify(output),
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            yield tag({
              type: "error",
              runId: myRunId,
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

    supportedModels: () => harness.supportedModels(),
  };
}

export { createAgentHarness };
export type { AgentHarnessOptions };
