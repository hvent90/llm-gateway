# Hypergraph Web Client Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat event DAG in `packages/ai/client/` with the conversation hypergraph from the design doc, then update the web client to use it.

**Architecture:** The current client SDK has a flat `Graph` (nodes + adjacency list) where each node is a content block. The hypergraph introduces a 4-level hierarchy (chunk → block → message → summary) with typed hyperedges and an active set for projection. The migration replaces `Graph` + `reduceEvent` + projections while keeping the same `ViewNode[]` and `Message[]` output shapes, so the web client rendering changes minimally.

**Tech Stack:** TypeScript, Bun test runner, React (web client)

**Reference:** `docs/plans/2026-02-12-conversation-hypergraph-design.md`

---

### Task 1: Hypergraph Core Types

Define the hypergraph type system as a new module alongside the existing graph. The old graph stays working throughout the migration — we build the new system in parallel and swap at the end.

**Files:**
- Create: `packages/ai/client/hypergraph/types.ts`
- Create: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/types.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/ai/client/hypergraph/__tests__/types.test.ts
import { describe, test, expect } from "bun:test";
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
} from "../types";

describe("Hypergraph Types", () => {
  test("ConversationNode discriminates on kind", () => {
    const chunk: ConversationNode = {
      id: "c1",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "hello" } as any,
    };
    const block: ConversationNode = { id: "b1", kind: "block" };
    const message: ConversationNode = { id: "m1", kind: "message" };

    expect(chunk.kind).toBe("chunk");
    expect(block.kind).toBe("block");
    expect(message.kind).toBe("message");

    // Only chunk has content
    if (chunk.kind === "chunk") {
      expect(chunk.content).toBeDefined();
    }
  });

  test("HyperEdge discriminates on type with typed roles", () => {
    const seq: HyperEdge = {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    };
    const blk: HyperEdge = {
      id: "e2",
      type: "block",
      roles: { part: ["c1", "c2"], whole: ["b1"] },
      properties: {},
    };
    const msg: HyperEdge = {
      id: "e3",
      type: "message",
      roles: { part: ["b1", "b2"], whole: ["m1"] },
      properties: {},
    };
    const sum: HyperEdge = {
      id: "e4",
      type: "summary",
      roles: { source: ["m1", "m2"], result: ["s1"] },
      properties: { model: "claude" },
    };
    const spn: HyperEdge = {
      id: "e5",
      type: "spawn",
      roles: { trigger: ["tc1"], invocation: ["hs1"] },
      properties: {},
    };

    expect(seq.type).toBe("sequence");
    expect(blk.type).toBe("block");
    expect(msg.type).toBe("message");
    expect(sum.type).toBe("summary");
    expect(spn.type).toBe("spawn");

    // Type narrowing works
    if (seq.type === "sequence") {
      expect(seq.roles.predecessor).toEqual(["a"]);
      expect(seq.roles.successor).toEqual(["b"]);
    }
    if (sum.type === "summary") {
      expect(sum.roles.source).toEqual(["m1", "m2"]);
      expect(sum.properties.model).toBe("claude");
    }
  });

  test("ConversationGraph holds nodes and edges", () => {
    const graph: ConversationGraph = {
      nodes: new Map(),
      edges: new Map(),
    };
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the types**

```typescript
// packages/ai/client/hypergraph/types.ts
import type { HarnessEvent } from "../../types";

export type NodeId = string;
export type EdgeId = string;

export type ConversationNode =
  | { id: NodeId; kind: "chunk"; content: HarnessEvent }
  | { id: NodeId; kind: "block" }
  | { id: NodeId; kind: "message" };

export type EdgeType = "sequence" | "block" | "message" | "summary" | "spawn";

export type EdgeRole =
  | "predecessor"
  | "successor"
  | "part"
  | "whole"
  | "source"
  | "result"
  | "trigger"
  | "invocation";

export type SequenceEdge = {
  id: EdgeId;
  type: "sequence";
  roles: { predecessor: NodeId[]; successor: NodeId[] };
  properties: Record<string, unknown>;
};
export type BlockEdge = {
  id: EdgeId;
  type: "block";
  roles: { part: NodeId[]; whole: NodeId[] };
  properties: Record<string, unknown>;
};
export type MessageEdge = {
  id: EdgeId;
  type: "message";
  roles: { part: NodeId[]; whole: NodeId[] };
  properties: Record<string, unknown>;
};
export type SummaryEdge = {
  id: EdgeId;
  type: "summary";
  roles: { source: NodeId[]; result: NodeId[] };
  properties: Record<string, unknown>;
};
export type SpawnEdge = {
  id: EdgeId;
  type: "spawn";
  roles: { trigger: NodeId[]; invocation: NodeId[] };
  properties: Record<string, unknown>;
};

export type HyperEdge = SequenceEdge | BlockEdge | MessageEdge | SummaryEdge | SpawnEdge;

export type ConversationGraph = {
  nodes: Map<NodeId, ConversationNode>;
  edges: Map<EdgeId, HyperEdge>;
};
```

```typescript
// packages/ai/client/hypergraph/index.ts
export type {
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
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/
git commit -m "feat(hypergraph): add core type definitions"
```

---

### Task 2: Graph Primitives — addNode, addEdge, extendEdge, getNode

Implement the write and read primitives with edge participant indexing for O(1) lookups.

**Files:**
- Create: `packages/ai/client/hypergraph/primitives.ts`
- Modify: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/primitives.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/ai/client/hypergraph/__tests__/primitives.test.ts
import { describe, test, expect } from "bun:test";
import {
  createGraph,
  addNode,
  addEdge,
  extendEdge,
  getNode,
  findEdges,
} from "../primitives";
import type { ConversationNode, HyperEdge } from "../types";

describe("Graph Primitives", () => {
  test("createGraph returns empty graph", () => {
    const g = createGraph();
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
  });

  test("addNode inserts a node and returns its id", () => {
    const g = createGraph();
    const node: ConversationNode = { id: "c1", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "hi" } as any };
    const g2 = addNode(g, node);
    expect(g2.nodes.size).toBe(1);
    expect(g2.nodes.get("c1")).toEqual(node);
    // Original unchanged
    expect(g.nodes.size).toBe(0);
  });

  test("addEdge creates a hyperedge", () => {
    let g = createGraph();
    g = addNode(g, { id: "a", kind: "block" });
    g = addNode(g, { id: "b", kind: "block" });
    g = addEdge(g, {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    });
    expect(g.edges.size).toBe(1);
    expect(g.edges.get("e1")!.type).toBe("sequence");
  });

  test("extendEdge appends node ids to a role participant list", () => {
    let g = createGraph();
    g = addNode(g, { id: "c1", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "a" } as any });
    g = addNode(g, { id: "c2", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "b" } as any });
    g = addNode(g, { id: "b1", kind: "block" });
    g = addEdge(g, {
      id: "e1",
      type: "block",
      roles: { part: ["c1"], whole: ["b1"] },
      properties: {},
    });
    g = extendEdge(g, "e1", "part", ["c2"]);
    const edge = g.edges.get("e1")!;
    if (edge.type === "block") {
      expect(edge.roles.part).toEqual(["c1", "c2"]);
    }
  });

  test("getNode retrieves a node by id", () => {
    let g = createGraph();
    g = addNode(g, { id: "m1", kind: "message" });
    expect(getNode(g, "m1")).toEqual({ id: "m1", kind: "message" });
    expect(getNode(g, "nonexistent")).toBeNull();
  });

  test("findEdges queries by type", () => {
    let g = createGraph();
    g = addEdge(g, { id: "e1", type: "sequence", roles: { predecessor: ["a"], successor: ["b"] }, properties: {} });
    g = addEdge(g, { id: "e2", type: "block", roles: { part: ["c1"], whole: ["b1"] }, properties: {} });
    const seqEdges = findEdges(g, { type: "sequence" });
    expect(seqEdges.length).toBe(1);
    expect(seqEdges[0]!.id).toBe("e1");
  });

  test("findEdges queries by node participant", () => {
    let g = createGraph();
    g = addEdge(g, { id: "e1", type: "sequence", roles: { predecessor: ["a"], successor: ["b"] }, properties: {} });
    g = addEdge(g, { id: "e2", type: "block", roles: { part: ["a", "c"], whole: ["d"] }, properties: {} });
    // Find all edges involving node "a"
    const edges = findEdges(g, { node: "a" });
    expect(edges.length).toBe(2);
  });

  test("findEdges queries by node and role", () => {
    let g = createGraph();
    g = addEdge(g, { id: "e1", type: "block", roles: { part: ["c1", "c2"], whole: ["b1"] }, properties: {} });
    // c1 in part role
    const partEdges = findEdges(g, { node: "c1", role: "part" });
    expect(partEdges.length).toBe(1);
    // c1 NOT in whole role
    const wholeEdges = findEdges(g, { node: "c1", role: "whole" });
    expect(wholeEdges.length).toBe(0);
  });

  test("findEdges queries by type + node + role", () => {
    let g = createGraph();
    g = addEdge(g, { id: "e1", type: "block", roles: { part: ["c1"], whole: ["b1"] }, properties: {} });
    g = addEdge(g, { id: "e2", type: "message", roles: { part: ["b1"], whole: ["m1"] }, properties: {} });
    // b1 is in "whole" of block edge AND "part" of message edge
    const blockWhole = findEdges(g, { type: "block", node: "b1", role: "whole" });
    expect(blockWhole.length).toBe(1);
    expect(blockWhole[0]!.id).toBe("e1");
    const messagePart = findEdges(g, { type: "message", node: "b1", role: "part" });
    expect(messagePart.length).toBe(1);
    expect(messagePart[0]!.id).toBe("e2");
  });

  test("graph is immutable — addNode does not mutate original", () => {
    const g1 = createGraph();
    const g2 = addNode(g1, { id: "x", kind: "block" });
    expect(g1.nodes.size).toBe(0);
    expect(g2.nodes.size).toBe(1);
  });

  test("graph is immutable — addEdge does not mutate original", () => {
    const g1 = createGraph();
    const g2 = addEdge(g1, { id: "e1", type: "sequence", roles: { predecessor: ["a"], successor: ["b"] }, properties: {} });
    expect(g1.edges.size).toBe(0);
    expect(g2.edges.size).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/primitives.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

The key design choice: `ConversationGraph` stores a `nodeIndex: Map<NodeId, Set<EdgeId>>` for O(1) lookups in `findEdges`. This index is internal — the public `ConversationGraph` type from `types.ts` is the logical shape, but the runtime object carries the index.

```typescript
// packages/ai/client/hypergraph/primitives.ts
import type {
  NodeId,
  EdgeId,
  ConversationNode,
  HyperEdge,
  ConversationGraph,
  EdgeType,
  EdgeRole,
} from "./types";

/**
 * Internal graph representation with edge participant index.
 * The index maps each NodeId to the set of EdgeIds it participates in.
 */
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
  };
}

export function addNode(graph: ConversationGraph, node: ConversationNode): ConversationGraph {
  const g = ensureIndexed(graph);
  const nodes = new Map(g.nodes);
  nodes.set(node.id, node);
  return { nodes, edges: g.edges, nodeIndex: new Map(g.nodeIndex) } as ConversationGraph;
}

export function addEdge(graph: ConversationGraph, edge: HyperEdge): ConversationGraph {
  const g = ensureIndexed(graph);
  const edges = new Map(g.edges);
  edges.set(edge.id, edge);
  const nodeIndex = new Map(g.nodeIndex);
  // Index all participants
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

  // Update index
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

export function getNode(graph: ConversationGraph, id: NodeId): ConversationNode | null {
  return graph.nodes.get(id) ?? null;
}

export interface FindEdgesQuery {
  type?: EdgeType;
  node?: NodeId;
  role?: EdgeRole;
}

export function findEdges(graph: ConversationGraph, query: FindEdgesQuery): HyperEdge[] {
  const g = ensureIndexed(graph);

  // If we have a node constraint, use the index
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
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/primitives.test.ts`
Expected: PASS

**Step 5: Update index.ts exports**

Add to `packages/ai/client/hypergraph/index.ts`:

```typescript
export { createGraph, addNode, addEdge, extendEdge, getNode, findEdges } from "./primitives";
export type { FindEdgesQuery } from "./primitives";
```

**Step 6: Commit**

```bash
git add packages/ai/client/hypergraph/
git commit -m "feat(hypergraph): add graph primitives with edge indexing"
```

---

### Task 3: Relationship Queries

Named functions for navigating the hierarchy: `chunksOf`, `blocksOf`, `sourcesOf` (downward) and `blockOf`, `messageOf`, `summariesOf` (upward).

**Files:**
- Create: `packages/ai/client/hypergraph/queries.ts`
- Modify: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/queries.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/ai/client/hypergraph/__tests__/queries.test.ts
import { describe, test, expect } from "bun:test";
import { createGraph, addNode, addEdge } from "../primitives";
import { chunksOf, blocksOf, sourcesOf, blockOf, messageOf, summariesOf } from "../queries";

describe("Relationship Queries", () => {
  test("chunksOf returns part nodes from block edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "c1", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "a" } as any });
    g = addNode(g, { id: "c2", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "b" } as any });
    g = addNode(g, { id: "b1", kind: "block" });
    g = addEdge(g, { id: "e1", type: "block", roles: { part: ["c1", "c2"], whole: ["b1"] }, properties: {} });
    expect(chunksOf(g, "b1")).toEqual(["c1", "c2"]);
  });

  test("blocksOf returns part nodes from message edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "b1", kind: "block" });
    g = addNode(g, { id: "b2", kind: "block" });
    g = addNode(g, { id: "m1", kind: "message" });
    g = addEdge(g, { id: "e1", type: "message", roles: { part: ["b1", "b2"], whole: ["m1"] }, properties: {} });
    expect(blocksOf(g, "m1")).toEqual(["b1", "b2"]);
  });

  test("sourcesOf returns source nodes from summary edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "m1", kind: "message" });
    g = addNode(g, { id: "m2", kind: "message" });
    g = addNode(g, { id: "s1", kind: "message" });
    g = addEdge(g, { id: "e1", type: "summary", roles: { source: ["m1", "m2"], result: ["s1"] }, properties: {} });
    expect(sourcesOf(g, "s1")).toEqual(["m1", "m2"]);
  });

  test("blockOf returns the whole from block edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "c1", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "a" } as any });
    g = addNode(g, { id: "b1", kind: "block" });
    g = addEdge(g, { id: "e1", type: "block", roles: { part: ["c1"], whole: ["b1"] }, properties: {} });
    expect(blockOf(g, "c1")).toBe("b1");
  });

  test("messageOf returns the whole from message edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "b1", kind: "block" });
    g = addNode(g, { id: "m1", kind: "message" });
    g = addEdge(g, { id: "e1", type: "message", roles: { part: ["b1"], whole: ["m1"] }, properties: {} });
    expect(messageOf(g, "b1")).toBe("m1");
  });

  test("summariesOf returns result nodes from summary edges", () => {
    let g = createGraph();
    g = addNode(g, { id: "m1", kind: "message" });
    g = addNode(g, { id: "s1", kind: "message" });
    g = addNode(g, { id: "s2", kind: "message" });
    g = addEdge(g, { id: "e1", type: "summary", roles: { source: ["m1"], result: ["s1"] }, properties: {} });
    g = addEdge(g, { id: "e2", type: "summary", roles: { source: ["m1"], result: ["s2"] }, properties: {} });
    expect(summariesOf(g, "m1")).toEqual(["s1", "s2"]);
  });

  test("upward queries return null when no edge exists", () => {
    let g = createGraph();
    g = addNode(g, { id: "c1", kind: "chunk", content: { type: "text", id: "t1", runId: "r1", content: "a" } as any });
    expect(blockOf(g, "c1")).toBeNull();
    expect(messageOf(g, "c1")).toBeNull();
    expect(summariesOf(g, "c1")).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/queries.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/ai/client/hypergraph/queries.ts
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
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/queries.test.ts`
Expected: PASS

**Step 5: Update index.ts and commit**

```bash
git add packages/ai/client/hypergraph/
git commit -m "feat(hypergraph): add relationship query functions"
```

---

### Task 4: Reducer — Chunk Nodes and Block Edges

The core reducer that transforms `ServerEvent`/`UserEvent` streams into hypergraph operations. This task handles chunk creation and block boundary detection (id-based). Message boundary detection is Task 5.

The reducer must handle:
- Every event becomes a chunk node
- Streaming text/reasoning with same `id` extends the block edge (appends chunk)
- New `id` starts a new block
- Sequence edges between chunks and between blocks
- `parentId` creates spawn edges (cross-run causation)

**Files:**
- Create: `packages/ai/client/hypergraph/reducer.ts`
- Modify: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/reducer.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/ai/client/hypergraph/__tests__/reducer.test.ts
import { describe, test, expect } from "bun:test";
import { createGraph } from "../primitives";
import { reduceEvent } from "../reducer";
import { findEdges, getNode } from "../primitives";
import { chunksOf, blockOf } from "../queries";
import type { ConversationGraph } from "../types";

// Same GraphEvent type as existing graph.ts
type GraphEvent = any; // Will use ServerEvent | UserEvent

function buildGraph(events: GraphEvent[]): ConversationGraph {
  let g = createGraph();
  for (const e of events) g = reduceEvent(g, e);
  return g;
}

describe("Hypergraph Reducer", () => {
  test("text event creates chunk node and block node", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
    ]);
    // Should have 2 nodes: one chunk, one block
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(1);
    expect(blocks.length).toBe(1);
    // Chunk stores the event
    if (chunks[0]!.kind === "chunk") {
      expect(chunks[0]!.content.type).toBe("text");
    }
    // Block edge links chunk to block
    const blockEdges = findEdges(g, { type: "block" });
    expect(blockEdges.length).toBe(1);
    expect(blockEdges[0]!.roles.part.length).toBe(1);
  });

  test("streaming text with same id extends block edge", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "world" },
    ]);
    // Should have 2 chunks, 1 block
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(2);
    expect(blocks.length).toBe(1);
    // Block edge has both chunks
    const blockEdges = findEdges(g, { type: "block" });
    expect(blockEdges[0]!.roles.part.length).toBe(2);
  });

  test("different text ids create separate blocks", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "First" },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "Second" },
    ]);
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(blocks.length).toBe(2);
    // Sequence edge between blocks
    const seqEdges = findEdges(g, { type: "sequence", node: blocks[0]!.id, role: "predecessor" });
    expect(seqEdges.length).toBe(1);
  });

  test("reasoning then text creates separate blocks", () => {
    const g = buildGraph([
      { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "Hmm" },
      { type: "text", id: "t1", runId: "run1", agentId: "a1", content: "Answer" },
    ]);
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(blocks.length).toBe(2);
  });

  test("tool_call creates a chunk and block", () => {
    const g = buildGraph([
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
    ]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(1);
    expect(blocks.length).toBe(1);
  });

  test("tool_result with same id as tool_call creates a separate block", () => {
    const g = buildGraph([
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "bash", output: "file.txt" },
    ]);
    // tool_call block + tool_result block
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(blocks.length).toBe(2);
  });

  test("chunk sequence edges follow event arrival order", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    expect(chunks.length).toBe(3); // harness_start, text, harness_end
    // Sequence edges connect them in order
    const seqEdges = findEdges(g, { type: "sequence" });
    // At chunk level: at least 2 sequence edges (hs->text, text->he)
    const chunkSeqs = seqEdges.filter((e) => {
      const pred = e.roles.predecessor[0]!;
      const node = g.nodes.get(pred);
      return node?.kind === "chunk";
    });
    expect(chunkSeqs.length).toBeGreaterThanOrEqual(2);
  });

  test("parentId creates spawn edge", () => {
    const g = buildGraph([
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "agent", input: { task: "go" } },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
    ]);
    const spawnEdges = findEdges(g, { type: "spawn" });
    expect(spawnEdges.length).toBe(1);
    // trigger should reference the tool_call chunk, invocation the harness_start chunk
    expect(spawnEdges[0]!.roles.trigger.length).toBe(1);
    expect(spawnEdges[0]!.roles.invocation.length).toBe(1);
  });

  test("connected event is ignored", () => {
    const g = buildGraph([{ type: "connected", sessionId: "s-1" }]);
    expect(g.nodes.size).toBe(0);
  });

  test("user event creates chunk and block", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" }]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(1);
    expect(blocks.length).toBe(1);
  });

  test("graph is immutable", () => {
    const g1 = createGraph();
    const g2 = reduceEvent(g1, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" });
    expect(g1.nodes.size).toBe(0);
    expect(g2.nodes.size).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/reducer.test.ts`
Expected: FAIL

**Step 3: Write the reducer**

The reducer maintains internal state (last chunk per run, current block id per run) in a `ReducerState` that accompanies the graph. The state tracks what's needed for block boundary detection and sequence edge construction.

The implementer should reference the design doc section "Streaming Reduction" and "Block Boundaries" for the algorithm:
- New `id` → start new block (addNode chunk, addNode block, addEdge block, addEdge sequence)
- Same `id` as current block → extend block (addNode chunk, extendEdge)
- Each event type derives its chunk node id deterministically (same scheme as current `deriveNodeId`)
- `tool_result` uses `${id}:result` suffix to distinguish from `tool_call` with same id

The `ReducerState` tracks:
- `lastChunkByRunId: Map<string, string>` — for chunk-level sequence edges
- `lastBlockByRunId: Map<string, string>` — for block-level sequence edges
- `currentBlockIdByRunId: Map<string, string>` — the event `id` of the block currently being built per run
- `currentBlockEdgeByRunId: Map<string, string>` — the EdgeId of the block edge being extended
- `chunkCounter: number` — for generating unique chunk node ids

The implementer should store the `ReducerState` alongside the `ConversationGraph`, either as a wrapper type or by convention. The public API returns `ConversationGraph` — the reducer state is internal.

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/reducer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/
git commit -m "feat(hypergraph): add reducer with chunk/block creation"
```

---

### Task 5: Reducer — Message Boundary Detection

Extend the reducer to detect message boundaries and create message nodes + message edges. Message boundaries are detected by:
- **Role transition** — user event after assistant content (or vice versa)
- **Text after tool results** — text content appearing after tool_result blocks signals a new assistant turn
- **`harness_end`** — closes the current message

This replicates the logic in `projections/messages.ts:projectMessages()` but moves it into the reducer so messages are first-class graph nodes.

**Files:**
- Modify: `packages/ai/client/hypergraph/reducer.ts`
- Test: `packages/ai/client/hypergraph/__tests__/reducer-messages.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/ai/client/hypergraph/__tests__/reducer-messages.test.ts
import { describe, test, expect } from "bun:test";
import { createGraph, findEdges } from "../primitives";
import { reduceEvent } from "../reducer";
import { blocksOf } from "../queries";
import type { ConversationGraph } from "../types";

type GraphEvent = any;

function buildGraph(events: GraphEvent[]): ConversationGraph {
  let g = createGraph();
  for (const e of events) g = reduceEvent(g, e);
  return g;
}

describe("Hypergraph Reducer — Message Boundaries", () => {
  test("harness_end creates a message node grouping all blocks in the run", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBe(1);
    // Message edge groups blocks
    const msgEdges = findEdges(g, { type: "message" });
    expect(msgEdges.length).toBe(1);
    // Should contain the text block (harness_start and harness_end are structural)
    expect(msgEdges[0]!.roles.part.length).toBeGreaterThanOrEqual(1);
  });

  test("user event creates its own message node", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
    ]);
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBe(1);
  });

  test("text after tool_result triggers new message in same run", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Sure" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "bash", output: "file.txt" },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "Done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    // Should have multiple messages: assistant (text + tool_call), tool, assistant (text)
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test("multi-turn conversation has message sequence edges", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "What is 2+2?" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", parentId: "u1:user", content: "4" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
      { type: "user", runId: "u2", content: "And 3+3?" },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "u2:user" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", parentId: "u2:user", content: "6" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
    ]);
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBe(4); // 2 user + 2 assistant
    // Should have sequence edges between messages
    const msgSeqs = findEdges(g, { type: "sequence" }).filter((e) => {
      const pred = g.nodes.get(e.roles.predecessor[0]!);
      return pred?.kind === "message";
    });
    expect(msgSeqs.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/reducer-messages.test.ts`
Expected: FAIL

**Step 3: Implement message boundary detection**

Extend the reducer's `ReducerState` with:
- `pendingBlocksByRunId: Map<string, NodeId[]>` — blocks accumulated since last message boundary
- `lastMessageId: NodeId | null` — for message-level sequence edges
- `hadToolResultSinceLastText: Map<string, boolean>` — detects text-after-tool-result boundary

The implementer should reference the design doc section "Message Boundaries" for the algorithm.

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/reducer-messages.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/
git commit -m "feat(hypergraph): add message boundary detection to reducer"
```

---

### Task 6: Active Set and Walk Algorithm

Implement the active set projection and walk algorithm from the design doc. This is the core mechanism that replaces the current ad-hoc node filtering.

**Files:**
- Create: `packages/ai/client/hypergraph/walk.ts`
- Modify: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/walk.test.ts`

**Step 1: Write the failing test**

Tests should cover:
- `defaultActive` — returns all message nodes, swapping summarized sources for summaries
- `fullHistoryActive` — returns all message nodes, ignoring summaries
- `walk` — yields nodes in sequence order following the active set
- Walk handles mixed levels (after expanding a message into blocks)
- Walk handles summaries (follows summary path when summary is active)
- `validate` — rejects active sets with ambiguous successors
- `findHead` — finds the root of the active path

The implementer should reference the design doc section "Active Set" and "Traversal" for the algorithm. Build test graphs using primitives directly (addNode, addEdge).

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/walk.test.ts`
Expected: FAIL

**Step 3: Implement walk algorithm**

Implement the functions from the design doc:
- `defaultActive(graph) → Set<NodeId>`
- `fullHistoryActive(graph) → Set<NodeId>`
- `walk(graph, active) → Generator<ConversationNode>`
- `findHead(graph, active) → NodeId | null`
- `findNextActive(graph, current, active) → NodeId | null`
- `findPrevActive(graph, current, active) → NodeId | null`
- `descendToFirstActive(graph, nodeId, active) → NodeId | null`
- `findAggregate(graph, nodeId) → NodeId | null`
- `validate(graph, active) → boolean`

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/walk.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/
git commit -m "feat(hypergraph): add active set and walk algorithm"
```

---

### Task 7: Derived Content — deriveBlockContent and deriveMessageContent

Functions that derive `ViewContent` and `Message` from chunk nodes by walking composition edges. These replace the current `nodeToViewContent` (which reads from stored node content) and `projectMessages` (which builds messages from ViewNodes).

**Files:**
- Create: `packages/ai/client/hypergraph/derived.ts`
- Modify: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/derived.test.ts`

**Step 1: Write the failing test**

Tests should verify:
- `deriveBlockContent` produces correct `ViewContent` for text blocks (concatenated text)
- `deriveBlockContent` produces correct `ViewContent` for reasoning blocks
- `deriveBlockContent` produces correct `ViewContent` for tool_call blocks (with output from tool_result)
- `deriveBlockContent` for user blocks
- `deriveMessageContent` assembles blocks into a `Message` with correct role
- `deriveMessageContent` handles assistant messages with tool_calls
- `deriveMessageContent` handles tool messages

Build test graphs with known chunk content and verify derived output matches expected `ViewContent`/`Message`.

Reference: existing `nodeToViewContent` in `projections/thread.ts:77-107` for the current derivation logic. The new version derives from chunks rather than stored node content.

**Step 2-5: Implement, test, commit**

Run: `bun test packages/ai/client/hypergraph/__tests__/derived.test.ts`

```bash
git commit -m "feat(hypergraph): add derived content functions"
```

---

### Task 8: Projections — projectThread and projectMessages

Rewrite the projection functions to work on the hypergraph. These must produce the same `ViewNode[]` and `Message[]` shapes as the current projections, ensuring the web client rendering works without changes.

**Files:**
- Create: `packages/ai/client/hypergraph/projections/thread.ts`
- Create: `packages/ai/client/hypergraph/projections/messages.ts`
- Test: `packages/ai/client/hypergraph/__tests__/projections/thread.test.ts`
- Test: `packages/ai/client/hypergraph/__tests__/projections/messages.test.ts`

**Step 1: Write tests using the SAME test cases as existing projections**

Port every test from:
- `packages/ai/client/__tests__/projections/thread.test.ts`
- `packages/ai/client/__tests__/projections/messages.test.ts`

Use the new `reduceEvent` (from hypergraph/reducer) to build graphs, then assert the same expected outputs. This is the conformance guarantee — if the new projections produce the same output for the same event sequences, the migration is safe.

The key differences:
- `buildGraph` uses new `reduceEvent` from `hypergraph/reducer`
- `projectThread` comes from `hypergraph/projections/thread`
- `projectMessages` comes from `hypergraph/projections/messages`
- Output shapes (`ViewNode[]`, `Message[]`) are identical

**Step 2: Implement projections**

`projectThread`:
1. Build active set via `defaultActive(graph)`
2. Walk the active set
3. For each message node: derive blocks, convert to `ViewNode[]`
4. Handle branches: find spawn edges from tool_call chunks, recurse
5. Handle streaming status: derive from harness_start/harness_end chunk presence
6. Merge consecutive text/reasoning ViewNodes (same behavior as current)
7. Attach tool_result output and tool_progress to tool_call ViewNodes

`projectMessages`:
1. Build active set via `defaultActive(graph)`
2. Walk to get message nodes
3. For each message: `deriveMessageContent` → `Message`
4. Skip reasoning, error, relay — same as current

**Step 3: Run both test files**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/`
Expected: PASS — identical output to current projections

**Step 4: Commit**

```bash
git commit -m "feat(hypergraph): add thread and messages projections"
```

---

### Task 9: Consumer Operations — expand, collapse, append, summarize, branch

Implement the active set manipulation operations from the design doc. These are what make the hypergraph useful beyond the current system.

**Files:**
- Create: `packages/ai/client/hypergraph/operations.ts`
- Modify: `packages/ai/client/hypergraph/index.ts`
- Test: `packages/ai/client/hypergraph/__tests__/operations.test.ts`

**Step 1: Write the failing test**

Tests for:
- `expand(graph, active, nodeId)` — swaps a message for its blocks in the active set
- `collapse(graph, active, nodeIds)` — swaps blocks back for their message
- `append(graph, active, event)` — adds a new message to the end of the active path
- `summarize(graph, active, sourceIds, summaryMessage)` — creates summary edge and parallel path
- `branch(graph, active, fromNodeId)` — forks the active set at a point
- `toggle(graph, active, nodeId)` — adds/removes a single node

**Step 2-5: Implement, test, commit**

Run: `bun test packages/ai/client/hypergraph/__tests__/operations.test.ts`

```bash
git commit -m "feat(hypergraph): add consumer operations"
```

---

### Task 10: Conversation State Wrapper

Create a new `ConversationState` that wraps the hypergraph + active set + session metadata. This replaces the current `conversation.ts`.

**Files:**
- Create: `packages/ai/client/hypergraph/conversation.ts`
- Test: `packages/ai/client/hypergraph/__tests__/conversation.test.ts`

**Step 1: Write the failing test**

Port tests from `packages/ai/client/__tests__/conversation.test.ts`:
- `createInitialConversation` returns empty state
- `connected` event sets sessionId
- `user` event creates nodes in graph
- `relay` events manage pendingRelays
- `stream_start`/`stream_end` toggle isConnected
- `reduceConversation` delegates to hypergraph reducer

Same test assertions, different internals.

**Step 2-5: Implement, test, commit**

```bash
git commit -m "feat(hypergraph): add conversation state wrapper"
```

---

### Task 11: Swap Web Client to Hypergraph

Update the web client to import from the hypergraph module instead of the old graph module. Since `ViewNode[]` and `Message[]` shapes are identical, the rendering components should work without changes.

**Files:**
- Modify: `clients/web/src/App.tsx` — change imports
- Modify: `clients/web/src/components/ConversationThread.tsx` — change imports
- Modify: `clients/web/src/types.ts` — update type re-exports
- Modify: `packages/ai/client/hypergraph/index.ts` — ensure all needed exports

**Step 1: Update imports in App.tsx**

Change:
```typescript
import { createSSETransport, createHTTPTransport, projectMessages } from "../../../packages/ai/client";
import { reduceConversation, createInitialConversation } from "../../../packages/ai/client";
```
To:
```typescript
import { createSSETransport, createHTTPTransport } from "../../../packages/ai/client";
import { reduceConversation, createInitialConversation, projectMessages } from "../../../packages/ai/client/hypergraph";
```

**Step 2: Update ConversationThread.tsx imports**

Change `projectThread` and type imports to come from hypergraph module.

**Step 3: Update types.ts**

Re-export `ConversationGraph` instead of `Graph`, and `ConversationState` from hypergraph.

**Step 4: Run existing tests to verify nothing breaks**

Run: `bun test packages/ai/client/hypergraph/`
Run: `bun test packages/ai/client/__tests__/client-integration.test.ts` (if adapted to use new module)

**Step 5: Manual smoke test**

Run: `bun run dev` and `bun run dev:web`
Verify the web client still works: send a message, see response, tool calls render correctly.

**Step 6: Commit**

```bash
git commit -m "feat(web): swap to hypergraph client SDK"
```

---

### Task 12: Integration Tests

Port the integration tests to use the hypergraph and verify end-to-end behavior.

**Files:**
- Create: `packages/ai/client/hypergraph/__tests__/integration.test.ts`
- Reference: `packages/ai/client/__tests__/client-integration.test.ts`

Port every test from `client-integration.test.ts` to use hypergraph imports. Same test server setup, same assertions.

**Step 1-5: Write tests, verify, commit**

```bash
git commit -m "test(hypergraph): port integration tests"
```

---

### Task 13: Clean Up Old Graph Module (optional, separate PR)

Once the hypergraph is working and all consumers are migrated, remove the old graph module. This is a separate PR to keep the migration PR reviewable.

**Files to remove:**
- `packages/ai/client/graph.ts`
- `packages/ai/client/types.ts` (Node, Graph types)
- `packages/ai/client/conversation.ts`
- `packages/ai/client/projections/thread.ts`
- `packages/ai/client/projections/messages.ts`
- `packages/ai/client/__tests__/graph.test.ts`
- `packages/ai/client/__tests__/conversation.test.ts`
- `packages/ai/client/__tests__/projections/`

**Files to update:**
- `packages/ai/client/index.ts` — re-export from hypergraph instead
- Any other consumers of old graph module

---

## Dependency Graph

```
Task 1 (types)
  ↓
Task 2 (primitives) ← Task 3 (queries)
  ↓
Task 4 (reducer: chunks/blocks)
  ↓
Task 5 (reducer: messages)
  ↓
Task 6 (walk) ← Task 7 (derived content)
  ↓
Task 8 (projections)
  ↓
Task 9 (operations)
  ↓
Task 10 (conversation state)
  ↓
Task 11 (web client swap)
  ↓
Task 12 (integration tests)
  ↓
Task 13 (cleanup — separate PR)
```

Tasks 1-3 can be parallelized (types → primitives and queries).
Tasks 6-7 can be parallelized (walk and derived content are independent).
Tasks 4-5 are sequential (message detection builds on block detection).

## Notes

- The old graph module stays working throughout. No consumer is broken until Task 11 swaps imports.
- `ServerEvent` and `HarnessEvent` types are unchanged — chunk nodes store them as-is.
- `ViewNode` and `ViewContent` types are unchanged — projections produce the same output.
- `Message` type is unchanged — message projection produces the same output.
- The SSE and HTTP transports are unchanged.
- React rendering components (`ConversationThread.tsx`) need only import changes, not logic changes.
