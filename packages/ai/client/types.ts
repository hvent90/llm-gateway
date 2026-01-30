/**
 * A node in the event graph. Discriminated union — one node per content block.
 */
export type Node = { id: string; runId: string } & (
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; eventId: string; name: string; input: unknown }
  | { kind: "tool_result"; eventId: string; name: string; output: unknown }
  | { kind: "user"; content: string }
  | { kind: "harness_start"; agentId: string }
  | { kind: "harness_end"; agentId: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | {
      kind: "relay";
      relayId: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    }
);

/**
 * Directed graph — typed nodes, untyped edges.
 */
export interface Graph {
  nodes: Map<string, Node>;
  edges: Map<string, string[]>; // adjacency list: sourceId → [targetId, ...]
}

/**
 * Internal reducer state. Extends Graph with bookkeeping for building edges.
 */
export interface GraphBuilderState extends Graph {
  nextId: number; // monotonic counter for generated node IDs
  lastNodeByRun: Map<string, string>; // runId → most recent nodeId in that run
}
