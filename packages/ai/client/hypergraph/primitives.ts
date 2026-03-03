import type {
  NodeId,
  EdgeId,
  ConversationNode,
  HyperEdge,
  SequenceEdge,
  BlockEdge,
  MessageEdge,
  SummaryEdge,
  SpawnEdge,
  ConversationGraph,
  EdgeType,
  EdgeRole,
} from "./types";

interface IndexedGraph extends ConversationGraph {
  nodeIndex: Map<NodeId, Set<EdgeId>>;
}

function ensureIndexed(graph: ConversationGraph): IndexedGraph {
  if ("nodeIndex" in graph) return graph as IndexedGraph;
  return { ...graph, nodeIndex: new Map() };
}

export function createGraph(): ConversationGraph {
  return {
    nodes: new Map(),
    edges: new Map(),
    nodeIndex: new Map(),
  } as ConversationGraph;
}

// ---------------------------------------------------------------------------
// Immutable operations — return new graph, original unchanged.
// Used by operations.ts, tests, and anywhere immutability matters.
// ---------------------------------------------------------------------------

export function addNode(graph: ConversationGraph, node: ConversationNode): ConversationGraph {
  const g = ensureIndexed(graph);
  const nodes = new Map(g.nodes);
  nodes.set(node.id, node);
  return {
    nodes,
    edges: g.edges,
    nodeIndex: new Map(g.nodeIndex),
  } as ConversationGraph;
}

export function addEdge(graph: ConversationGraph, edge: HyperEdge): ConversationGraph {
  const g = ensureIndexed(graph);
  const edges = new Map(g.edges);
  edges.set(edge.id, edge);
  const nodeIndex = new Map(g.nodeIndex);
  for (const nodeIds of Object.values(edge.roles)) {
    for (const nodeId of nodeIds as NodeId[]) {
      const existing = nodeIndex.get(nodeId);
      if (existing) {
        const copy = new Set(existing);
        copy.add(edge.id);
        nodeIndex.set(nodeId, copy);
      } else {
        nodeIndex.set(nodeId, new Set([edge.id]));
      }
    }
  }
  return { nodes: g.nodes, edges, nodeIndex } as ConversationGraph;
}

export function extendEdge(
  graph: ConversationGraph,
  edgeId: EdgeId,
  role: string,
  nodeIds: NodeId[],
): ConversationGraph {
  const g = ensureIndexed(graph);
  const existing = g.edges.get(edgeId);
  if (!existing) return graph;

  const edges = new Map(g.edges);
  const updatedRoles = { ...existing.roles } as Record<string, NodeId[]>;
  updatedRoles[role] = [...(updatedRoles[role] ?? []), ...nodeIds];
  edges.set(edgeId, { ...existing, roles: updatedRoles } as HyperEdge);

  const nodeIndex = new Map(g.nodeIndex);
  for (const nodeId of nodeIds) {
    const set = nodeIndex.get(nodeId);
    if (set) {
      const copy = new Set(set);
      copy.add(edgeId);
      nodeIndex.set(nodeId, copy);
    } else {
      nodeIndex.set(nodeId, new Set([edgeId]));
    }
  }

  return { nodes: g.nodes, edges, nodeIndex } as ConversationGraph;
}

// ---------------------------------------------------------------------------
// Mutable operations — mutate graph in place. O(1) per call.
// Used by the reducer hot path where the caller owns the graph.
// ---------------------------------------------------------------------------

export function addNodeMut(graph: ConversationGraph, node: ConversationNode): void {
  graph.nodes.set(node.id, node);
}

export function addEdgeMut(graph: ConversationGraph, edge: HyperEdge): void {
  const g = graph as IndexedGraph;
  g.edges.set(edge.id, edge);
  for (const nodeIds of Object.values(edge.roles)) {
    for (const nodeId of nodeIds as NodeId[]) {
      const existing = g.nodeIndex.get(nodeId);
      if (existing) {
        existing.add(edge.id);
      } else {
        g.nodeIndex.set(nodeId, new Set([edge.id]));
      }
    }
  }
}

export function extendEdgeMut(
  graph: ConversationGraph,
  edgeId: EdgeId,
  role: string,
  nodeIds: NodeId[],
): void {
  const g = graph as IndexedGraph;
  const existing = g.edges.get(edgeId);
  if (!existing) return;

  const roles = existing.roles as Record<string, NodeId[]>;
  const arr = roles[role];
  if (arr) {
    for (const id of nodeIds) arr.push(id);
  } else {
    roles[role] = [...nodeIds];
  }

  for (const nodeId of nodeIds) {
    const set = g.nodeIndex.get(nodeId);
    if (set) {
      set.add(edgeId);
    } else {
      g.nodeIndex.set(nodeId, new Set([edgeId]));
    }
  }
}

/**
 * Shallow-clone graph Maps so subsequent mutations don't affect the original.
 * Used at the start of reduceEvent to create a mutable working copy.
 */
export function cloneGraph(graph: ConversationGraph): ConversationGraph {
  const g = ensureIndexed(graph);
  return {
    nodes: new Map(g.nodes),
    edges: new Map(g.edges),
    nodeIndex: new Map(g.nodeIndex),
  } as ConversationGraph;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export function getNode(graph: ConversationGraph, id: NodeId): ConversationNode | null {
  return graph.nodes.get(id) ?? null;
}

export interface FindEdgesQuery {
  type?: EdgeType;
  node?: NodeId;
  role?: EdgeRole;
}

export function findEdges(
  graph: ConversationGraph,
  query: FindEdgesQuery & { type: "sequence" },
): SequenceEdge[];
export function findEdges(
  graph: ConversationGraph,
  query: FindEdgesQuery & { type: "block" },
): BlockEdge[];
export function findEdges(
  graph: ConversationGraph,
  query: FindEdgesQuery & { type: "message" },
): MessageEdge[];
export function findEdges(
  graph: ConversationGraph,
  query: FindEdgesQuery & { type: "summary" },
): SummaryEdge[];
export function findEdges(
  graph: ConversationGraph,
  query: FindEdgesQuery & { type: "spawn" },
): SpawnEdge[];
export function findEdges(graph: ConversationGraph, query: FindEdgesQuery): HyperEdge[];
export function findEdges(graph: ConversationGraph, query: FindEdgesQuery): HyperEdge[] {
  const g = ensureIndexed(graph);

  let candidateIds: Iterable<EdgeId>;
  if (query.node) {
    const indexed = g.nodeIndex.get(query.node);
    if (!indexed) return [];
    candidateIds = indexed;
  } else {
    candidateIds = g.edges.keys();
  }

  const results: HyperEdge[] = [];
  for (const edgeId of candidateIds) {
    const edge = g.edges.get(edgeId);
    if (!edge) continue;
    if (query.type && edge.type !== query.type) continue;
    if (query.node && query.role) {
      const roleParticipants = (edge.roles as Record<string, NodeId[]>)[query.role];
      if (!roleParticipants || !roleParticipants.includes(query.node)) continue;
    }
    results.push(edge);
  }
  return results;
}
