import type { ServerEvent } from "./server-event";

/**
 * A node in the event graph, representing a single harness invocation.
 */
export interface GraphNode {
  runId: string;
  parentId?: string;
  role: "user" | "assistant";
  events: ServerEvent[];
}

/**
 * The complete graph state - minimal, events as source of truth.
 */
export interface GraphState {
  nodes: Map<string, GraphNode>;
}
