import type { ContentPart } from "../types";

/**
 * A node in the conversation graph.
 * Each node represents one content block — not one "message" or one "run."
 */
export type Node = { id: string; runId: string } & (
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; output: unknown }
  | { kind: "tool_progress"; toolCallId: string; name: string; content: unknown }
  | { kind: "user"; content: string | ContentPart[] }
  | { kind: "harness_start"; agentId: string }
  | { kind: "harness_end"; agentId: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | {
      kind: "relay";
      relayKind: "permission";
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    }
);

/**
 * The conversation graph.
 * - nodes: all nodes keyed by id
 * - edges: adjacency list (sourceId → targetIds[])
 * - lastNodeByRunId: tracks the most recent node per runId for edge construction
 */
export interface Graph {
  nodes: Map<string, Node>;
  edges: Map<string, string[]>;
  lastNodeByRunId: Map<string, string>;
}
