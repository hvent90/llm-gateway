import type { GraphState } from "./types";
import type { ServerEvent } from "./server-event";

/**
 * Get runIds of all root nodes (no parentId).
 */
export function getRoots(state: GraphState): string[] {
  const roots: string[] = [];
  for (const [runId, node] of state.nodes) {
    if (!node.parentId) {
      roots.push(runId);
    }
  }
  return roots;
}

/**
 * Get runIds of all children of a given node.
 */
export function getChildren(state: GraphState, runId: string): string[] {
  const children: string[] = [];
  for (const [childRunId, node] of state.nodes) {
    if (node.parentId === runId) {
      children.push(childRunId);
    }
  }
  return children;
}

/**
 * Get concatenated text content for a node.
 */
export function getText(state: GraphState, runId: string): string {
  const node = state.nodes.get(runId);
  if (!node) return "";

  return node.events
    .filter((e): e is Extract<ServerEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.content)
    .join("");
}

/**
 * Get all tool calls for a node.
 */
export function getToolCalls(
  state: GraphState,
  runId: string,
): Array<{ id: string; name: string; input: unknown }> {
  const node = state.nodes.get(runId);
  if (!node) return [];

  return node.events
    .filter((e): e is Extract<ServerEvent, { type: "tool_call" }> => e.type === "tool_call")
    .map((e) => ({ id: e.id, name: e.name, input: e.input }));
}

/**
 * Get the status of a node based on its events.
 */
export function getStatus(state: GraphState, runId: string): "streaming" | "complete" | "error" {
  const node = state.nodes.get(runId);
  if (!node) return "complete";

  const hasError = node.events.some((e) => e.type === "error");
  if (hasError) return "error";

  const hasEnd = node.events.some((e) => e.type === "harness_end");
  if (hasEnd) return "complete";

  const hasStart = node.events.some((e) => e.type === "harness_start");
  if (hasStart) return "streaming";

  return "complete";
}

/**
 * A content block derived from a node's events.
 */
export type ContentBlock =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; output?: unknown };

/**
 * Build content blocks from a node's events.
 * Merges consecutive same-type text/reasoning events and attaches
 * tool_result output to matching tool_call blocks.
 */
export function getContentBlocks(state: GraphState, runId: string): ContentBlock[] {
  const node = state.nodes.get(runId);
  if (!node) return [];

  const toolResults = new Map<string, unknown>();
  for (const event of node.events) {
    if (event.type === "tool_result") {
      toolResults.set(event.id, event.output);
    }
  }

  const blocks: ContentBlock[] = [];
  for (const event of node.events) {
    if (event.type === "text" || event.type === "reasoning") {
      const last = blocks[blocks.length - 1];
      if (last && last.type === event.type) {
        (last as { content: string }).content += event.content;
      } else {
        blocks.push({ type: event.type, content: event.content });
      }
    } else if (event.type === "tool_call") {
      const block: ContentBlock = {
        type: "tool_call",
        id: event.id,
        name: event.name,
        input: event.input,
      };
      const output = toolResults.get(event.id);
      if (output !== undefined) {
        (block as { output?: unknown }).output = output;
      }
      blocks.push(block);
    }
  }

  return blocks;
}

/**
 * Get the role of a node.
 */
export function getRole(state: GraphState, runId: string): "user" | "assistant" | undefined {
  const node = state.nodes.get(runId);
  if (!node) return undefined;
  return node.role;
}
