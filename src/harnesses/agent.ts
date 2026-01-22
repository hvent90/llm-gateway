import { v7 as uuidv7 } from "uuid";
import type { HarnessModule, HarnessEvent, InvokeParams, ToolCall, ToolContext } from "../types";

interface AgentHarnessOptions {
  harness: HarnessModule;
  maxIterations?: number;
}

function createAgentHarness(options: AgentHarnessOptions): HarnessModule {
  const { harness, maxIterations = 10 } = options;

  return {
    async invoke({ emit, context, runId: providedRunId, ...params }: InvokeParams): Promise<void> {
      const runId = providedRunId ?? uuidv7();
      const parentId = context?.parentId;

      // Wrap emit to add parentId to events
      const taggedEmit = (event: HarnessEvent) => {
        emit(parentId ? { ...event, parentId } : event);
      };

      const messages = [...params.messages];
      let iterations = 0;

      while (iterations++ < maxIterations) {
        const toolCalls: ToolCall[] = [];
        let textContent = "";

        await harness.invoke({
          ...params,
          messages,
          runId,
          emit: (event) => {
            taggedEmit(event);
            if (event.type === "tool_call") {
              toolCalls.push({ id: event.id, name: event.name, arguments: event.input });
            }
            if (event.type === "text") {
              textContent += event.content;
            }
          },
        });

        if (toolCalls.length === 0) break;

        messages.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls,
        });

        for (const tc of toolCalls) {
          const toolDef = params.tools?.find((t) => t.name === tc.name);
          if (!toolDef?.execute) {
            taggedEmit({
              type: "error",
              runId,
              error: new Error(`No executor for tool: ${tc.name}`),
            });
            return;
          }

          const toolCtx: ToolContext = {
            emit: taggedEmit,
            parentId: tc.id, // This tool_call becomes parent for nested events
          };

          const { context: toolContext, result } = await toolDef.execute(tc.arguments, toolCtx);
          taggedEmit({ type: "tool_result", runId, name: tc.name, id: tc.id, output: result });

          if (toolContext !== undefined) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: toolContext,
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
