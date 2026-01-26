import type { HarnessEvent } from "../types";

/**
 * A node in the event graph, representing a single harness invocation.
 */
export interface GraphNode {
  runId: string;
  parentId?: string;
  events: HarnessEvent[];
}

/**
 * The complete graph state - minimal, events as source of truth.
 */
export interface GraphState {
  nodes: Map<string, GraphNode>;
}
