import { v7 as uuidv7 } from "uuid";
import type { HarnessModule, HarnessEvent, InvokeParams, ToolCall } from "../types";

interface ToolResultOutput {
  context?: string;
  result?: unknown;
}

interface AgentHarnessOptions {
  harness: HarnessModule;
  maxIterations?: number;
}

function createAgentHarness(options: AgentHarnessOptions): HarnessModule {
  const { harness, maxIterations = 10 } = options;

  return {
    async invoke({ emit, context, ...params }: InvokeParams): Promise<void> {
      const runId = context?.runId ?? uuidv7();
      const parentId = context?.parentId;

      // Wrap emit to add parentId to events
      const taggedEmit = (event: HarnessEvent) => {
        emit(parentId ? { ...event, parentId } : event);
      };

      const messages = [...params.messages];
      let iterations = 0;

      while (iterations++ < maxIterations) {
        const toolCalls: ToolCall[] = [];
        const toolResults: Map<string, ToolResultOutput> = new Map();
        let textContent = "";
        let permissionRequired = false;

        await harness.invoke({
          ...params,
          messages,
          context: { runId, parentId },
          emit: (event) => {
            taggedEmit(event);
            if (event.type === "tool_call") {
              toolCalls.push({ id: event.id, name: event.name, arguments: event.input });
            }
            if (event.type === "text") {
              textContent += event.content;
            }
            if (event.type === "tool_result") {
              // Collect tool results for building messages
              toolResults.set(event.id, event.output as ToolResultOutput);
            }
            if (event.type === "permission_required") {
              permissionRequired = true;
            }
          },
        });

        // Stop loop when permission is required - client should handle the permission request
        if (permissionRequired) {
          return;
        }

        if (toolCalls.length === 0) break;

        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls,
        });

        // Build tool messages from collected results
        for (const tc of toolCalls) {
          const resultOutput = toolResults.get(tc.id);
          if (!resultOutput) {
            // No result for this tool call - check if tool has no executor
            const toolDef = params.tools?.find((t) => t.name === tc.name);
            if (!toolDef?.execute) {
              taggedEmit({
                type: "error",
                runId,
                error: new Error(`No executor for tool: ${tc.name}`),
              });
              return;
            }
            // Executor exists but no result emitted - this is a bug
            taggedEmit({
              type: "error",
              runId,
              error: new Error(`Tool executor for '${tc.name}' did not emit a result`),
            });
            return;
          }

          if (resultOutput.context !== undefined) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: resultOutput.context,
            });
          }
        }
      }
    },

    supportedModels: () => harness.supportedModels(),
  };
}

export { createAgentHarness };
export type { AgentHarnessOptions };
