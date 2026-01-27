import type { ServerEvent } from "./server-event";
import type { GraphState, GraphNode } from "./types";

/**
 * Create an empty graph state.
 */
export function createInitialState(): GraphState {
  return {
    nodes: new Map(),
  };
}

/**
 * Pure reducer: apply a ServerEvent to produce new GraphState.
 */
export function reduceEvent(state: GraphState, event: ServerEvent): GraphState {
  // Skip connected events — no runId, handled by conversation layer
  if (event.type === "connected") return state;

  const runId = event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;

  // Get or create node for this runId
  const existingNode = state.nodes.get(runId);
  const node: GraphNode = existingNode
    ? { ...existingNode, events: [...existingNode.events, event] }
    : { runId, parentId, role: "assistant", events: [event] };

  // Create new Map with updated node
  const newNodes = new Map(state.nodes);
  newNodes.set(runId, node);

  return { nodes: newNodes };
}
