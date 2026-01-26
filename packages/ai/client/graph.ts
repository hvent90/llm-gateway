import type { HarnessEvent } from "../types";
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
 * Pure reducer: apply a HarnessEvent to produce new GraphState.
 */
export function reduceEvent(state: GraphState, event: HarnessEvent): GraphState {
  // Extract runId and parentId from event
  const runId = event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;

  // Get or create node for this runId
  const existingNode = state.nodes.get(runId);
  const node: GraphNode = existingNode
    ? { ...existingNode, events: [...existingNode.events, event] }
    : { runId, parentId, events: [event] };

  // Create new Map with updated node
  const newNodes = new Map(state.nodes);
  newNodes.set(runId, node);

  return { nodes: newNodes };
}
