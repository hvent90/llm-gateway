import type { ConversationGraph, ConversationNode, NodeId, EdgeType, EdgeRole } from "./types";
import { findEdges } from "./primitives";

export function defaultActive(graph: ConversationGraph): Set<NodeId> {
  const active = new Set<NodeId>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === "message") active.add(id);
  }
  for (const edge of graph.edges.values()) {
    if (edge.type === "summary") {
      edge.roles.source.forEach((id) => active.delete(id));
      edge.roles.result.forEach((id) => active.add(id));
    }
  }
  return active;
}

export function fullHistoryActive(graph: ConversationGraph): Set<NodeId> {
  const active = new Set<NodeId>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === "message") active.add(id);
  }
  return active;
}

export function* walk(graph: ConversationGraph, active: Set<NodeId>): Generator<ConversationNode> {
  let current = findHead(graph, active);
  while (current) {
    yield graph.nodes.get(current)!;
    current = findNextActive(graph, current, active);
  }
}

export function findHead(graph: ConversationGraph, active: Set<NodeId>): NodeId | null {
  for (const nodeId of active) {
    if (findPrevActive(graph, nodeId, active) === null) return nodeId;
  }
  return null;
}

export function findNextActive(
  graph: ConversationGraph,
  current: NodeId,
  active: Set<NodeId>,
): NodeId | null {
  // 1. Try same-level sequence successors
  const seqEdges = findEdges(graph, {
    type: "sequence",
    node: current,
    role: "predecessor",
  });
  for (const edge of seqEdges) {
    for (const successorId of edge.roles.successor) {
      if (active.has(successorId)) return successorId;
      const descended = descendToFirstActive(graph, successorId, active);
      if (descended) return descended;
    }
  }

  // 2. Climb up: find the aggregate this node belongs to, then find its successor
  const aggregate = findAggregate(graph, current);
  if (aggregate) {
    return findNextActive(graph, aggregate, active);
  }

  return null;
}

export function findPrevActive(
  graph: ConversationGraph,
  current: NodeId,
  active: Set<NodeId>,
): NodeId | null {
  // 1. Try same-level sequence predecessor
  const seqEdges = findEdges(graph, {
    type: "sequence",
    node: current,
    role: "successor",
  });
  for (const edge of seqEdges) {
    const prev = edge.roles.predecessor.find((id) => active.has(id));
    if (prev) return prev;
  }

  // 2. Climb up: find the aggregate, then check its predecessor
  const aggregate = findAggregate(graph, current);
  if (aggregate) {
    return findPrevActive(graph, aggregate, active);
  }

  return null;
}

export function descendToFirstActive(
  graph: ConversationGraph,
  nodeId: NodeId,
  active: Set<NodeId>,
): NodeId | null {
  const checks: Array<{
    type: EdgeType;
    aggregateRole: EdgeRole;
    constituentRole: EdgeRole;
  }> = [
    { type: "summary", aggregateRole: "result", constituentRole: "source" },
    { type: "message", aggregateRole: "whole", constituentRole: "part" },
    { type: "block", aggregateRole: "whole", constituentRole: "part" },
  ];
  for (const { type, aggregateRole, constituentRole } of checks) {
    const edges = findEdges(graph, { type, node: nodeId, role: aggregateRole });
    if (edges.length > 0) {
      const constituents = (edges[0]!.roles as Record<string, NodeId[]>)[constituentRole];
      if (constituents) {
        for (const partId of constituents) {
          if (active.has(partId)) return partId;
          const deeper = descendToFirstActive(graph, partId, active);
          if (deeper) return deeper;
        }
      }
    }
  }
  return null;
}

export function findAggregate(graph: ConversationGraph, nodeId: NodeId): NodeId | null {
  for (const edgeType of ["block", "message"] as const) {
    const edges = findEdges(graph, {
      type: edgeType,
      node: nodeId,
      role: "part",
    });
    if (edges.length > 0) return edges[0]!.roles.whole[0]!;
  }
  const summaryEdges = findEdges(graph, {
    type: "summary",
    node: nodeId,
    role: "source",
  });
  if (summaryEdges.length > 0) return summaryEdges[0]!.roles.result[0]!;
  return null;
}

export function validate(graph: ConversationGraph, active: Set<NodeId>): boolean {
  for (const nodeId of active) {
    const seqEdges = findEdges(graph, {
      type: "sequence",
      node: nodeId,
      role: "predecessor",
    });
    let activeSuccessorCount = 0;
    for (const edge of seqEdges) {
      for (const successorId of edge.roles.successor) {
        if (active.has(successorId)) activeSuccessorCount++;
      }
    }
    if (activeSuccessorCount > 1) return false;
  }
  return true;
}
