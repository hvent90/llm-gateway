import type { Message, ToolCall } from "../../../types";
import type { ConversationGraph } from "../types";
import { projectThread } from "./thread";

/**
 * Serialize a tool output value to a string for the tool message content.
 */
function serializeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

/**
 * Project a conversation hypergraph into LLM API Message[].
 *
 * Builds on `projectThread` — walks the flat ViewNode[] output (branches
 * excluded) and converts to the Message format expected by LLM APIs.
 */
export function projectMessages(graph: ConversationGraph): Message[] {
  const viewNodes = projectThread(graph);
  const messages: Message[] = [];

  // Accumulators for the current assistant turn
  let text: string | null = null;
  let toolCalls: ToolCall[] = [];
  let toolOutputs: Array<{ id: string; output: unknown }> = [];

  function flush() {
    if (text !== null || toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      for (const t of toolOutputs) {
        messages.push({
          role: "tool",
          tool_call_id: t.id,
          content: serializeOutput(t.output),
        });
      }
    }
    text = null;
    toolCalls = [];
    toolOutputs = [];
  }

  for (const node of viewNodes) {
    const c = node.content;

    switch (c.kind) {
      case "user":
        flush();
        messages.push({ role: "user", content: c.content });
        break;

      case "text":
        // Text after tool_calls means a new assistant turn
        if (toolCalls.length > 0) flush();
        text = text !== null ? text + c.text : c.text;
        break;

      case "tool_call":
        toolCalls.push({ id: node.id, name: c.name, arguments: c.input as any });
        if (c.output !== undefined) {
          toolOutputs.push({ id: node.id, output: c.output });
        }
        break;

      // reasoning, error, relay, pending — skip
      default:
        break;
    }
  }

  flush();
  return messages;
}
