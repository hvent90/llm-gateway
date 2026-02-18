import type { ConversationGraph, NodeId } from "./types";
import { findEdges } from "./primitives";

// Downward — aggregate to constituents

export function chunksOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "block", node: nodeId, role: "whole" });
  return edges[0]?.roles.part ?? [];
}

export function blocksOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "message", node: nodeId, role: "whole" });
  return edges[0]?.roles.part ?? [];
}

export function sourcesOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "summary", node: nodeId, role: "result" });
  return edges[0]?.roles.source ?? [];
}

// Upward — constituent to aggregate

export function blockOf(graph: ConversationGraph, nodeId: NodeId): NodeId | null {
  const edges = findEdges(graph, { type: "block", node: nodeId, role: "part" });
  return edges[0]?.roles.whole[0] ?? null;
}

export function messageOf(graph: ConversationGraph, nodeId: NodeId): NodeId | null {
  const edges = findEdges(graph, { type: "message", node: nodeId, role: "part" });
  return edges[0]?.roles.whole[0] ?? null;
}

export function summariesOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "summary", node: nodeId, role: "source" });
  return edges.map((e) => e.roles.result[0]!);
}
