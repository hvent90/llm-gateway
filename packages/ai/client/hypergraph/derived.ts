import type { ContentPart, Message, ToolCall } from "../../types";
import type { ConversationGraph, NodeId } from "./types";
import { getNode } from "./primitives";
import { chunksOf, blocksOf } from "./queries";

export type BlockContent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; input: unknown; output?: unknown; progress?: unknown }
  | { kind: "user"; content: string | ContentPart[] }
  | { kind: "error"; message: string }
  | {
      kind: "relay";
      relayKind: "permission";
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

/**
 * Derive ViewContent from a block node by walking its chunks.
 * Returns null for structural blocks (harness_start, harness_end, usage, tool_result, tool_progress).
 */
export function deriveBlockContent(graph: ConversationGraph, blockId: NodeId): BlockContent | null {
  const chunkIds = chunksOf(graph, blockId);
  if (chunkIds.length === 0) return null;

  const firstChunk = getNode(graph, chunkIds[0]!);
  if (!firstChunk || firstChunk.kind !== "chunk") return null;

  const event = firstChunk.content;

  switch (event.type) {
    case "text": {
      let text = "";
      for (const id of chunkIds) {
        const node = getNode(graph, id);
        if (node?.kind === "chunk" && node.content.type === "text") {
          text += node.content.content;
        }
      }
      return { kind: "text", text };
    }
    case "reasoning": {
      let text = "";
      for (const id of chunkIds) {
        const node = getNode(graph, id);
        if (node?.kind === "chunk" && node.content.type === "reasoning") {
          text += node.content.content;
        }
      }
      return { kind: "reasoning", text };
    }
    case "tool_call":
      return { kind: "tool_call", name: event.name, input: event.input };
    case "user":
      return { kind: "user", content: event.content };
    case "error":
      return { kind: "error", message: event.message };
    case "relay":
      return {
        kind: "relay",
        relayKind: event.kind,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
    case "tool_result":
    case "harness_start":
    case "harness_end":
    case "usage":
    case "tool_progress":
      return null;
    default:
      return null;
  }
}

function serializeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

/**
 * Derive LLM API Messages from a message node by walking its blocks.
 * Returns Message[] because a single message node may produce an assistant message
 * followed by tool result messages.
 */
export function deriveMessageContent(graph: ConversationGraph, messageId: NodeId): Message[] {
  const blockIds = blocksOf(graph, messageId);
  if (blockIds.length === 0) return [];

  // Check for user message first
  for (const blockId of blockIds) {
    const content = deriveBlockContent(graph, blockId);
    if (content?.kind === "user") {
      return [{ role: "user", content: content.content }];
    }
  }

  // Assistant message assembly
  let text: string | null = null;
  const toolCalls: ToolCall[] = [];
  const toolOutputs: Array<{ id: string; output: unknown }> = [];

  for (const blockId of blockIds) {
    const content = deriveBlockContent(graph, blockId);

    if (content) {
      switch (content.kind) {
        case "text":
          text = text !== null ? text + content.text : content.text;
          break;
        case "tool_call": {
          // Extract tool_call id from the first chunk event
          const chunkIds = chunksOf(graph, blockId);
          const firstChunk = getNode(graph, chunkIds[0]!);
          if (firstChunk?.kind === "chunk" && firstChunk.content.type === "tool_call") {
            toolCalls.push({
              id: firstChunk.content.id,
              name: content.name,
              arguments: content.input,
            });
          }
          break;
        }
        // reasoning, error, relay — skip for Message format
        default:
          break;
      }
    } else {
      // Check for tool_result in structural blocks
      const chunkIds = chunksOf(graph, blockId);
      for (const chunkId of chunkIds) {
        const node = getNode(graph, chunkId);
        if (node?.kind === "chunk" && node.content.type === "tool_result") {
          toolOutputs.push({ id: node.content.id, output: node.content.output });
        }
      }
    }
  }

  const messages: Message[] = [];
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

  return messages;
}
