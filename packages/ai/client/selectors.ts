import type { GraphState } from "./types";
import type { HarnessEvent } from "../types";

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
    .filter((e): e is Extract<HarnessEvent, { type: "text" }> => e.type === "text")
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
    .filter((e): e is Extract<HarnessEvent, { type: "tool_call" }> => e.type === "tool_call")
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

  // For now, assume streaming unless we add explicit completion events
  return "streaming";
}
