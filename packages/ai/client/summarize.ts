import { v7 } from "uuid";
import type { ConversationGraph, NodeId } from "./hypergraph/types";
import { summarize } from "./hypergraph/operations";

/**
 * Given collected summary text from the /summarize SSE stream,
 * wire it into the conversation graph using operations.summarize().
 *
 * Returns the updated graph, active set, and the new summary node ID.
 */
export function summarizeFromEvents(
  graph: ConversationGraph,
  active: Set<NodeId>,
  sourceIds: NodeId[],
  _summaryText: string,
): { graph: ConversationGraph; active: Set<NodeId>; summaryNodeId: NodeId } {
  const summaryNodeId = `summary:${v7()}` as NodeId;
  const summaryNode = { id: summaryNodeId, kind: "message" as const };

  const result = summarize(graph, active, sourceIds, summaryNode);

  return {
    graph: result.graph,
    active: result.active,
    summaryNodeId,
  };
}
