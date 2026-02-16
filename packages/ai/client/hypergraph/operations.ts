import type { ConversationGraph, ConversationNode, NodeId } from "./types";
import { addNode, addEdge, findEdges } from "./primitives";
import { walk, findHead, findPrevActive, findNextActive } from "./walk";

export function expand(graph: ConversationGraph, active: Set<NodeId>, nodeId: NodeId): Set<NodeId> {
  // Try block/message edges: nodeId in "whole" role → swap with "part" nodes
  for (const edgeType of ["block", "message"] as const) {
    const edges = findEdges(graph, { type: edgeType, node: nodeId, role: "whole" });
    if (edges.length > 0) {
      const parts = (edges[0]!.roles as Record<string, NodeId[]>).part ?? [];
      return substituteInSet(active, nodeId, parts);
    }
  }

  // Try summary edges: nodeId in "result" role → swap with "source" nodes
  const summaryEdges = findEdges(graph, { type: "summary", node: nodeId, role: "result" });
  if (summaryEdges.length > 0) {
    const sources = summaryEdges[0]!.roles.source;
    return substituteInSet(active, nodeId, sources);
  }

  return active;
}

export function collapse(
  graph: ConversationGraph,
  active: Set<NodeId>,
  nodeIds: NodeId[],
): Set<NodeId> {
  const nodeIdSet = new Set(nodeIds);

  // Try block/message edges: all nodeIds in "part" role → swap for "whole"
  for (const edgeType of ["block", "message"] as const) {
    const edges = findEdges(graph, { type: edgeType, node: nodeIds[0]!, role: "part" });
    for (const edge of edges) {
      const parts = (edge.roles as Record<string, NodeId[]>).part ?? [];
      if (parts.length === nodeIdSet.size && parts.every((p) => nodeIdSet.has(p))) {
        const whole = (edge.roles as Record<string, NodeId[]>).whole[0]!;
        return substituteInSet(active, nodeIds, [whole]);
      }
    }
  }

  // Try summary edges: all nodeIds in "source" role → swap for "result"
  const summaryEdges = findEdges(graph, { type: "summary", node: nodeIds[0]!, role: "source" });
  for (const edge of summaryEdges) {
    const sources = edge.roles.source;
    if (sources.length === nodeIdSet.size && sources.every((s) => nodeIdSet.has(s))) {
      const resultNode = edge.roles.result[0]!;
      return substituteInSet(active, nodeIds, [resultNode]);
    }
  }

  return active;
}

export function append(
  graph: ConversationGraph,
  active: Set<NodeId>,
  message: ConversationNode,
): { graph: ConversationGraph; active: Set<NodeId> } {
  let g = addNode(graph, message);
  const newActive = new Set(active);

  // Find the tail of the active path
  const tail = findTail(g, active);
  if (tail) {
    g = addEdge(g, {
      id: `seq:${tail}:${message.id}`,
      type: "sequence",
      roles: { predecessor: [tail], successor: [message.id] },
      properties: {},
    });
  }

  newActive.add(message.id);
  return { graph: g, active: newActive };
}

export function summarize(
  graph: ConversationGraph,
  active: Set<NodeId>,
  sourceIds: NodeId[],
  summaryNode: ConversationNode,
): { graph: ConversationGraph; active: Set<NodeId> } {
  let g = addNode(graph, summaryNode);

  // Add summary edge
  g = addEdge(g, {
    id: `sum:${summaryNode.id}`,
    type: "summary",
    roles: { source: sourceIds, result: [summaryNode.id] },
    properties: {},
  });

  // Find predecessor of first source
  const firstSource = sourceIds[0]!;
  const pred = findPrevActive(g, firstSource, active);

  // Find successor of last source
  const lastSource = sourceIds[sourceIds.length - 1]!;
  const succ = findNextActive(g, lastSource, active);

  // Position summary as parallel path
  if (pred) {
    g = addEdge(g, {
      id: `seq:${pred}:${summaryNode.id}`,
      type: "sequence",
      roles: { predecessor: [pred], successor: [summaryNode.id] },
      properties: {},
    });
  }
  if (succ) {
    g = addEdge(g, {
      id: `seq:${summaryNode.id}:${succ}`,
      type: "sequence",
      roles: { predecessor: [summaryNode.id], successor: [succ] },
      properties: {},
    });
  }

  // Update active set
  const newActive = new Set(active);
  for (const id of sourceIds) newActive.delete(id);
  newActive.add(summaryNode.id);
  return { graph: g, active: newActive };
}

export function branch(
  graph: ConversationGraph,
  active: Set<NodeId>,
  fromNodeId: NodeId,
): Set<NodeId> {
  // Walk the active path and include everything up to fromNodeId
  const result = new Set<NodeId>();
  for (const node of walk(graph, active)) {
    result.add(node.id);
    if (node.id === fromNodeId) break;
  }
  return result;
}

export function toggle(
  _graph: ConversationGraph,
  active: Set<NodeId>,
  nodeId: NodeId,
): Set<NodeId> {
  const result = new Set(active);
  if (result.has(nodeId)) {
    result.delete(nodeId);
  } else {
    result.add(nodeId);
  }
  return result;
}

// Substitute one or more nodes in a Set, preserving iteration order.
// Replacements are inserted at the position of the first removed node.
function substituteInSet(
  set: Set<NodeId>,
  remove: NodeId | NodeId[],
  insert: NodeId[],
): Set<NodeId> {
  const removeSet = new Set(Array.isArray(remove) ? remove : [remove]);
  const result = new Set<NodeId>();
  let inserted = false;
  for (const id of set) {
    if (removeSet.has(id)) {
      if (!inserted) {
        for (const newId of insert) result.add(newId);
        inserted = true;
      }
    } else {
      result.add(id);
    }
  }
  return result;
}

function findTail(graph: ConversationGraph, active: Set<NodeId>): NodeId | null {
  let current = findHead(graph, active);
  if (!current) return null;
  let next = findNextActive(graph, current, active);
  while (next) {
    current = next;
    next = findNextActive(graph, current, active);
  }
  return current;
}
