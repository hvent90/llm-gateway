# Conversation Hypergraph Design

## Problem

The current system passes a flat `Message[]` to LLM providers. This array grows monotonically — every tool call, every failed attempt, every retry accumulates. When an agent burns through context on trial-and-error, there's no way to reclaim that space without destroying history.

We need a data structure that supports:

- **Non-destructive summarization** — replace a range of messages with a summary for the LLM, but keep the originals
- **Branching** — fork a conversation from any point
- **Full history** — see every summarization that ever happened
- **Flexible projection** — different consumers (agent harness, web client, debug tools) decide independently what the LLM sees

## Why a Hypergraph

A regular graph's edges connect exactly two nodes. A hypergraph's edges (hyperedges) connect arbitrary sets of nodes. This matters because summarization is inherently a many-to-one relationship: N messages become 1 summary. Expressing this as a first-class edge — rather than N separate edges or a side table — keeps the structure honest.

A **directed** hypergraph gives each hyperedge a tail set (sources) and head set (targets). We extend this with **roles** following TypeDB's model, where each participant has a named role that describes its relationship to the edge. This makes edges self-describing — you don't need to know conventions to interpret them.

### Authoritative References

- **TypeDB** (formerly Grakn, by Vaticle) — a production hypergraph database implementing the PERA model (Polymorphic Entity-Relation-Attribute). Relations are first-class objects that connect entities through named roles, and relations can participate in other relations. This is the most mature production system for typed hypergraphs.
  - PERA model guide: https://typedb.com/fundamentals/pera-model-guide/
  - PERA comparison with other models: https://typedb.com/fundamentals/pera-comparison
  - Modeling data with hypergraphs: https://medium.com/vaticle/modelling-data-with-hypergraphs-edff1e12edf0
  - Academy lesson: https://typedb.com/docs/academy/9-modeling-schemas/9.1-the-pera-model/
- **XGI** — Python library for directed hypergraphs. Defines a directed hyperedge as `(tail, head)` where both are sets of vertices. Our design extends this with named roles.
  - Directed hypergraphs: https://xgi.readthedocs.io/en/stable/api/tutorials/focus_7.html
- **HyperGraphDB** — Java generalized hypergraph database where everything is an "atom" (node or link). Links have a typed target set and can point to other links.
  - Paper: https://hypergraphdb.org/docs/hypergraphdb.pdf
- **Formal definition** — A directed hypergraph is a pair H = (V, E), where V is a set of vertices and E is a set of directed hyperedges. Each directed hyperedge is an ordered pair (tail, head) where both tail and head are subsets of V.
  - Directed hypergraphs survey: https://www.sciencedirect.com/science/article/pii/S0304397516002097
  - Wikipedia: https://en.wikipedia.org/wiki/Hypergraph

## Multi-Granularity Unification

The current system has two graph structures: a server-side `Message[]` (flat, mutable) and a client-side event `Graph` (DAG of content blocks built from streaming events). The hypergraph unifies these into one structure by operating at multiple levels of granularity.

Chunks are the existing `HarnessEvent`s — every event that is currently streamed (text, reasoning, tool_call, tool_result, tool_progress, usage, error, harness_start, harness_end, relay) becomes a node in the graph. There is no separate streaming buffer; the graph IS the streaming state. As events arrive, they become chunk nodes with sequence edges.

The hierarchy has four levels, matching the existing client SDK terminology where each node represents one "content block":

- **block** edge: N chunks → 1 content block node (e.g., N reasoning chunks → 1 reasoning block)
- **message** edge: N content blocks → 1 message node
- **summary** edge: N messages → 1 summary node
- **sequence** edge: ordering at any level

The following diagram shows a concrete example: an assistant message with reasoning, text, and a tool call, followed by two more messages that get summarized. Every node and edge in the graph is shown, with grouping edges on the left and sequence edges on the right.

```
┌─ SUMMARY LEVEL ──────────────────────────────────────────────────────────────┐
│                                                                              │
│  summary_1                                                                   │
│  (derived — Message from summarization LLM chunks)                           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
       ▲
       │ summary edge
       │ roles: { source: [msg_1, msg_2, msg_3], result: [summary_1] }
       │
┌─ MESSAGE LEVEL ──────────────────────────────────────────────────────────────┐
│                                                                              │
│  msg_1 ───seq───▸ msg_2 ───seq───▸ msg_3                                    │
│  (derived —        (derived —        (derived —                              │
│   Message)          Message)          Message)                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
       ▲
       │ message edge
       │ roles: { part: [reason_blk, text_blk, tc_blk, tr_blk], whole: [msg_1] }
       │
┌─ BLOCK LEVEL ────────────────────────────────────────────────────────────────┐
│                                                                              │
│  reason_blk ──seq──▸ text_blk ──seq──▸ tc_blk ──seq──▸ tr_blk              │
│  (derived —           (derived —        (derived —       (derived —           │
│   ViewContent)         ViewContent)      ViewContent)     ViewContent)         │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
       ▲                      ▲
       │ block edge           │ block edge
       │ { part: [r1,r2],    │ { part: [t1,t2,t3],
       │   whole: [reason_blk] } │   whole: [text_blk] }
       │                      │
┌─ CHUNK LEVEL ────────────────────────────────────────────────────────────────┐
│                                                                              │
│  r1 ─seq─▸ r2 ─seq─▸ t1 ─seq─▸ t2 ─seq─▸ t3 ─seq─▸ tc1 ─seq─▸ tr1       │
│  (HarnessEvent:       (HarnessEvent:        (HarnessEvent: (HarnessEvent:    │
│   type=reasoning)      type=text)            type=tool_call) type=tool_result)│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘


NAVIGATION:

  Downward (expand):              Upward (collapse):
  summary_1                       r1
    │ sourcesOf()                   │ blockOf()
    ▼                               ▼
  msg_1, msg_2, msg_3            reason_blk
    │ blocksOf()                    │ messageOf()
    ▼                               ▼
  reason_blk, text_blk, ...      msg_1
    │ chunksOf()                    │ summariesOf()
    ▼                               ▼
  r1, r2                         summary_1


ACTIVE SETS — same graph, different views:

  Chunk-level:   { r1, r2, t1, t2, t3, tc1, tr1, ... }  → streaming/rendering
  Block-level:   { reason_blk, text_blk, tc_blk, tr_blk, ... }  → content block view
  Message-level: { msg_1, msg_2, msg_3 }  → LLM context
  Summary-level: { summary_1 }  → compressed conversation
```

Expand and collapse are the same operation at every level. Expand swaps an aggregate for its constituents in the active set. Collapse does the reverse — swaps constituents for their aggregate. Neither mutates the graph.

This eliminates the need for a separate client-side event graph. There is one graph. Different consumers project it at different granularities.

## Core Data Structure

### Nodes

Every node carries a `kind` discriminant. Only chunk nodes store content directly — they are the source of truth. Block and message nodes are content-free aggregation points; their content is derived on demand from their children via composition edges.

```typescript
type NodeId = string;

type ConversationNode =
  | { id: NodeId; kind: "chunk"; content: HarnessEvent }
  | { id: NodeId; kind: "block" }
  | { id: NodeId; kind: "message" }
```

`kind` reflects the node's graph role. Chunk nodes hold the raw `HarnessEvent`. Block and message nodes exist as aggregation anchors — their `ViewContent` and `Message` are derived by walking composition edges down to chunks (see [Derived Content](#derived-content)). Summary nodes are message nodes that participate in a summary edge — detected via `findEdges(graph, { type: "summary", node: id, role: "result" })` rather than a separate kind. Summary content is also derived: the summarization LLM call produces chunks like any other LLM call, and the summary message is composed from those chunks through the normal hierarchy.

### Hyperedges

Following TypeDB's model, each participant in a hyperedge has a named role. The edge type determines what roles exist and what they mean. This is a labeled, role-based directed hyperedge.

```typescript
type EdgeId = string;

type EdgeType = "sequence" | "block" | "message" | "summary" | "spawn";

type EdgeRole = "predecessor" | "successor" | "part" | "whole" | "source" | "result" | "trigger" | "invocation";

type SequenceEdge = { id: EdgeId; type: "sequence"; roles: { predecessor: NodeId[]; successor: NodeId[] }; properties: Record<string, unknown> };
type BlockEdge    = { id: EdgeId; type: "block";    roles: { part: NodeId[]; whole: NodeId[] };                 properties: Record<string, unknown> };
type MessageEdge  = { id: EdgeId; type: "message";  roles: { part: NodeId[]; whole: NodeId[] };                 properties: Record<string, unknown> };
type SummaryEdge  = { id: EdgeId; type: "summary";  roles: { source: NodeId[]; result: NodeId[] };              properties: Record<string, unknown> };
type SpawnEdge    = { id: EdgeId; type: "spawn";     roles: { trigger: NodeId[]; invocation: NodeId[] };         properties: Record<string, unknown> };

type HyperEdge = SequenceEdge | BlockEdge | MessageEdge | SummaryEdge | SpawnEdge;
```

### Graph

The graph is just nodes and edges. No `head` pointer, no separate ordering structure — ordering is expressed entirely through sequence edges.

```typescript
type ConversationGraph = {
  nodes: Map<NodeId, ConversationNode>;
  edges: Map<EdgeId, HyperEdge>;
};
```

### Edge Types

| Relationship | Edge type | Notes |
|---|---|---|
| Temporal ordering | `sequence` | All levels |
| Chunk → block composition | `block` | Lossless |
| Block → message composition | `message` | Lossless |
| Summarization | `summary` | Lossy |
| Causation (tool_call → harness) | `spawn` | Replaces `runId`/`parentId` |
| Turn-taking (user → assistant) | `sequence` | At message level |
| Branching | Multiple sequence successors | Emergent, no dedicated edge |
| Retry/edit | TBD | May be branching or its own edge type |

**Sequence** — expresses ordering between nodes at any level:

```typescript
{
  id: "e1",
  type: "sequence",
  roles: { predecessor: ["msg_1"], successor: ["msg_2"] },
  properties: {}
}
```

**Block** — groups chunks into a content block:

```typescript
{
  id: "e2",
  type: "block",
  roles: { part: ["reason_1", "reason_2", "reason_3"], whole: ["reasoning_blk_1"] },
  properties: {}
}
```

**Message** — groups content blocks into a single message:

```typescript
{
  id: "e3",
  type: "message",
  roles: { part: ["reasoning_blk_1", "text_blk_1", "tc_blk_1"], whole: ["msg_1"] },
  properties: {}
}
```

**Summary** — groups messages into a summary:

```typescript
{
  id: "e4",
  type: "summary",
  roles: { source: ["msg_3", "msg_4", "msg_5"], result: ["summary_1"] },
  properties: { timestamp: 1234, model: "claude-sonnet-4-5-20250929" }
}
```

All three grouping edge types (`block`, `message`, `summary`) follow the same pattern: N constituents → 1 aggregate. Expand swaps the aggregate for its constituents; collapse does the reverse. Both are active set operations, not graph mutations.

**Spawn** — a tool call caused a harness invocation:

```typescript
{
  id: "e5",
  type: "spawn",
  roles: { trigger: ["tc_1"], invocation: ["harness_start_a2"] },
  properties: {}
}
```

Spawn edges represent causation: a `tool_call` node triggered a harness invocation. This is not specific to "subagents" — any harness invocation caused by a tool call gets a spawn edge. The root harness invocation (triggered by a user message) does not use a spawn edge; user → assistant turn-taking is expressed through sequence edges at the message level.

Chunk nodes preserve `runId` and `parentId` from `HarnessEvent` in their content — the hypergraph doesn't strip existing metadata. Spawn edges make these relationships structural (queryable via `findEdges`) while the content fields provide fast lookups when needed. Both representations coexist; spawn edges are the canonical form, content fields are a convenience.

**Future work:** The agent harness currently re-tags provider harness events with its own `runId`, discarding per-iteration identity. Making the provider harness emit its own events (with its own `runId` and `harness_start`/`harness_end`) would give each agent loop iteration a natural grouping in the graph. This is a separate change from the hypergraph design.

Adding a new edge type means adding a variant to both the `EdgeType` union and the `HyperEdge` discriminated union (with its specific typed roles), then handling it in switches. The compiler enforces exhaustive handling — a missing case is a type error.

## Parallel Paths

When a summary is created, sequence edges are added to position the summary node in the graph. The original sequence is never modified.

```
Original:    2 →seq→ 3 →seq→ 4 →seq→ 5 →seq→ 7
                ↘                          ↗
Summary:         →seq→ 6 →seq→────────────
```

Both paths coexist. Which path is followed is determined at read time by the active set.

## Branching

Branching works the same way. Forking from node 5 creates a new successor:

```
Original:    1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
                                ↘
Branch:                          → 9 → 10
```

Node 5 has two sequence successors (6 and 9). The active set determines which branch is followed.

## Projection

### Active Set

A projection is a `Set<NodeId>` — a filter that determines which nodes are included. This is not an ordered structure; ordering comes from walking the graph's sequence edges. The set answers "is this node included?" and the edges answer "in what order?"

**Invariant:** For any node in the active set, at most one of its sequence successors may also be in the active set. If this invariant is violated, the projection is ambiguous and should be rejected.

### Building the Active Set

Different consumers build the active set differently:

```typescript
// Agent default: message-level, preferring summaries over originals
function defaultActive(graph: ConversationGraph): Set<NodeId> {
  // Start with message-level nodes only (not chunks, blocks, or summaries)
  const active = new Set<NodeId>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === "message") active.add(id);
  }
  // Swap summarized sources for summary result nodes
  for (const edge of graph.edges.values()) {
    if (edge.type === "summary") {
      edge.roles.source.forEach(id => active.delete(id));
      edge.roles.result.forEach(id => active.add(id));
    }
  }
  return active;
}

// Full history: all messages active, ignore summaries
function fullHistoryActive(graph: ConversationGraph): Set<NodeId> {
  const active = new Set<NodeId>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === "message") active.add(id);
  }
  return active;
}

// Web client: user toggles nodes on/off
function customActive(userSelection: NodeId[]): Set<NodeId> {
  return new Set(userSelection);
}
```

### Traversal

The core walk is hierarchy-aware — it follows sequence edges filtered by the active set, climbing up and down composition edges when the active set spans multiple levels (e.g., after expanding a message into its blocks).

```typescript
function* walk(graph: ConversationGraph, active: Set<NodeId>): Generator<ConversationNode> {
  let current = findHead(graph, active);
  while (current) {
    yield graph.nodes.get(current)!;
    current = findNextActive(graph, current, active);
  }
}

function findHead(graph: ConversationGraph, active: Set<NodeId>): NodeId | null {
  // Find active node with no active predecessor (accounting for hierarchy).
  // Assumes the active set forms a connected sequence (single root).
  for (const nodeId of active) {
    if (findPrevActive(graph, nodeId, active) === null) return nodeId;
  }
  return null;
}

function findNextActive(graph: ConversationGraph, current: NodeId, active: Set<NodeId>): NodeId | null {
  // 1. Try same-level sequence successors
  const seqEdges = findEdges(graph, { type: "sequence", node: current, role: "predecessor" });
  for (const edge of seqEdges) {
    for (const successorId of edge.roles.successor) {
      // Successor is active — use it directly
      if (active.has(successorId)) return successorId;
      // Successor might be expanded — descend into its first active part
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

function descendToFirstActive(graph: ConversationGraph, nodeId: NodeId, active: Set<NodeId>): NodeId | null {
  // Check if this node has been expanded — find its constituents via composition/summary edges.
  // Order: summary first (coarsest), then message, then block (finest).
  // Summary edges use result/source roles; block/message edges use whole/part roles.
  const checks: Array<{ type: EdgeType; aggregateRole: EdgeRole; constituentRole: EdgeRole }> = [
    { type: "summary", aggregateRole: "result", constituentRole: "source" },
    { type: "message", aggregateRole: "whole",  constituentRole: "part" },
    { type: "block",   aggregateRole: "whole",  constituentRole: "part" },
  ];
  for (const { type, aggregateRole, constituentRole } of checks) {
    const edges = findEdges(graph, { type, node: nodeId, role: aggregateRole });
    if (edges.length > 0) {
      for (const partId of edges[0].roles[constituentRole]) {
        if (active.has(partId)) return partId;
        const deeper = descendToFirstActive(graph, partId, active);
        if (deeper) return deeper;
      }
    }
  }
  return null;
}

function findPrevActive(graph: ConversationGraph, current: NodeId, active: Set<NodeId>): NodeId | null {
  // 1. Try same-level sequence predecessor
  const seqEdges = findEdges(graph, { type: "sequence", node: current, role: "successor" });
  for (const edge of seqEdges) {
    const prev = edge.roles.predecessor.find(id => active.has(id));
    if (prev) return prev;
  }

  // 2. Climb up: find the aggregate, then check its predecessor
  const aggregate = findAggregate(graph, current);
  if (aggregate) {
    return findPrevActive(graph, aggregate, active);
  }

  return null;
}

function findAggregate(graph: ConversationGraph, nodeId: NodeId): NodeId | null {
  // Check composition edges in order of granularity (block → message → summary).
  // Block/message edges use part/whole roles; summary edges use source/result roles.
  for (const edgeType of ["block", "message"] as const) {
    const edges = findEdges(graph, { type: edgeType, node: nodeId, role: "part" });
    if (edges.length > 0) return edges[0].roles.whole[0];
  }
  // Check summary edges (message → summary transition)
  const summaryEdges = findEdges(graph, { type: "summary", node: nodeId, role: "source" });
  if (summaryEdges.length > 0) return summaryEdges[0].roles.result[0];
  return null;
}
```

When the active set is all at one level (e.g., all messages), the walk follows same-level sequence edges directly. When levels are mixed (e.g., after expanding `msg_1` into blocks, or expanding a summary into its source messages), the walk handles two transitions:

- **Climb:** The walk reaches the last constituent of a group, finds no same-level successor, climbs to the aggregate via `findAggregate`, and checks the aggregate's sequence successors. This works across all composition levels — block→message via `part`/`whole`, and message→summary via `source`/`result`.
- **Descend:** If a successor is not in the active set (it has been expanded), `descendToFirstActive` recurses into its constituents to find the first active node. This handles summary→message descent (via `result`/`source`) as well as message→block and block→chunk descent (via `whole`/`part`).

This lets the active set freely mix levels without requiring cross-level sequence edges.

### Typed Projections

Projection functions filter by `kind` and derive content from the graph. Chunk projections read stored content directly. Block and message projections derive content from their children via composition edges.

```typescript
function chunks(graph: ConversationGraph, active: Set<NodeId>): HarnessEvent[] {
  return [...walk(graph, active)]
    .filter(n => n.kind === "chunk")
    .map(n => n.content);
}

function blocks(graph: ConversationGraph, active: Set<NodeId>): ViewContent[] {
  return [...walk(graph, active)]
    .filter(n => n.kind === "block")
    .map(n => deriveBlockContent(graph, n.id));
}

function messages(graph: ConversationGraph, active: Set<NodeId>): Message[] {
  return [...walk(graph, active)]
    .filter(n => n.kind === "message")
    .map(n => deriveMessageContent(graph, n.id));
}
```

### Derived Content

Block and message nodes don't store content — it's derived from chunks on demand.

```typescript
function deriveBlockContent(graph: ConversationGraph, blockId: NodeId): ViewContent {
  const chunkIds = chunksOf(graph, blockId);
  const events = chunkIds.map(id => (graph.nodes.get(id)! as { content: HarnessEvent }).content);
  // Derive ViewContent from chunk events — e.g., concatenate text deltas
  // The derivation logic depends on chunk type (text, reasoning, tool_call, etc.)
  return deriveFromEvents(events);
}

function deriveMessageContent(graph: ConversationGraph, messageId: NodeId): Message {
  const blockIds = blocksOf(graph, messageId);
  const content = blockIds.map(id => deriveBlockContent(graph, id));
  // Assemble blocks into a Message with role, content array, etc.
  // Role is determined by block types (user blocks → "user", otherwise "assistant")
  return assembleMessage(content);
}
```

Derivation is always possible because chunks — the source of truth — are immutable. A block's `ViewContent` is the concatenation of its chunks' content. A message's `Message` is the assembly of its blocks' content. A summary's content is derived the same way — the summarization LLM call produces chunks, which compose into blocks, which compose into the summary message node. No special case.

### Relationship Queries

Each level gets its own named functions. Each queries a specific edge type.

**Downward** — from aggregate to constituents:

```typescript
function chunksOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "block", node: nodeId, role: "whole" });
  return edges[0]?.roles.part ?? [];
}

function blocksOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "message", node: nodeId, role: "whole" });
  return edges[0]?.roles.part ?? [];
}

function sourcesOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "summary", node: nodeId, role: "result" });
  return edges[0]?.roles.source ?? [];
}
```

**Upward** — from constituent to aggregate:

```typescript
function blockOf(graph: ConversationGraph, nodeId: NodeId): NodeId | null {
  const edges = findEdges(graph, { type: "block", node: nodeId, role: "part" });
  return edges[0]?.roles.whole[0] ?? null;
}

function messageOf(graph: ConversationGraph, nodeId: NodeId): NodeId | null {
  const edges = findEdges(graph, { type: "message", node: nodeId, role: "part" });
  return edges[0]?.roles.whole[0] ?? null;
}

function summariesOf(graph: ConversationGraph, nodeId: NodeId): NodeId[] {
  const edges = findEdges(graph, { type: "summary", node: nodeId, role: "source" });
  return edges.map(e => e.roles.result[0]);
}
```

`summariesOf` returns an array because a message can appear in multiple summaries (overlapping ranges, hierarchical re-summarization). All other upward functions return a single node — a chunk belongs to exactly one block, a block to exactly one message.

### Validation

```typescript
function validate(graph: ConversationGraph, active: Set<NodeId>): boolean {
  for (const nodeId of active) {
    const successors = findSequenceSuccessors(graph, nodeId);
    const activeSuccessors = successors.filter(id => active.has(id));
    if (activeSuccessors.length > 1) return false;
  }
  return true;
}
```

## Operations

### Primitives

The graph only grows: nodes and edges are never removed, and edge participant lists only append (monotonic growth). There is no `removeNode`, `removeEdge`, or operation that shrinks a participant list.

**Writes:**
- **addNode(graph, node) → NodeId** — create a node
- **addEdge(graph, type, roles, properties) → EdgeId** — create a hyperedge
- **extendEdge(graph, edgeId, role, nodeIds)** — append node ids to an existing edge's role participant list. Used during streaming to grow block edges as new chunks arrive. Monotonic — never removes participants.

**Reads:**
- **getNode(graph, id) → ConversationNode** — retrieve a node
- **findEdges(graph, { type?: EdgeType, node?: NodeId, role?: EdgeRole }) → HyperEdge[]** — query edges by type, participant, role, or any combination. When `type` is specified, the returned edges can be narrowed to the corresponding variant (e.g., `SummaryEdge`). Implementations should index edges by participant node (e.g., `Map<NodeId, EdgeId[]>`) for O(1) lookup.

### Consumer Operations

These are what users of the graph actually want to do. Each composes from the four primitives.

**append(graph, active, message)** — add a message to the end of the current path:
1. `addNode` → newId
2. `findEdges` to locate the tail of the active path
3. `addEdge("sequence", { predecessor: [tailId], successor: [newId] })`
4. Add newId to active set

**summarize(graph, active, sourceIds, summaryMessage)** — replace a range with a summary:
1. `addNode(summaryMessage)` → summaryId
2. `addEdge("summary", { source: sourceIds, result: [summaryId] })`
3. `findEdges` to find the predecessor of the first source and successor of the last source
4. `addEdge("sequence", ...)` to position the summary node as a parallel path
5. Remove sourceIds from active, add summaryId

**branch(graph, active, fromNodeId)** — fork from any point:
- No graph mutation. Construct a new active set including everything up to `fromNodeId`. The fork materializes when `append` creates a new sequence edge from `fromNodeId`.

**project(graph, active)** — produce a `Message[]`:
- `findEdges` repeatedly to walk sequence edges, `getNode` to collect messages. The walk traverses through inactive nodes without including them.

**expand(graph, active, nodeId)** — replace an aggregate with its constituents in the active set:
- Works at any level. For block/message nodes: find the edge where `nodeId` is in the `whole` role, swap with `part` nodes. For summary nodes: find the edge where `nodeId` is in the `result` role, swap with `source` nodes. No graph mutation.

**collapse(graph, active, nodeIds)** — replace constituents with their aggregate in the active set:
- The reverse of expand. Find the grouping edge where all `nodeIds` are in the `part`/`source` role, swap them for the `whole`/`result` node. Only works when the grouping edge already exists (block and message edges are created by the reducer during streaming; summary edges are created by `summarize`). No graph mutation.

**toggle(graph, active, nodeId)** — include or exclude a single node:
- `active.add(nodeId)` or `active.delete(nodeId)`. Removing is always safe. Adding requires re-validation (could introduce a second active successor at a fork).

**inspect(graph, nodeId)** — find all relationships a node participates in:
- `findEdges({ node: nodeId })` — returns every edge involving the node.

**validate(graph, active)** — check the active set invariant:
- `findEdges` for each active node to count active successors.

### Pattern

Writes only mutate the graph (`addNode`, `addEdge`, `extendEdge`). Everything else — branching, expanding, toggling, switching branches — reshapes the active set using reads. The graph only grows; edge participant lists only append.

### Active Set as Cursor

The active set serves triple duty:

- **What you read** — which nodes appear in the projection
- **Where you write** — append extends the tail of the active path
- **Which branch you're on** — which successor to follow at fork points

## Placement

The event stream is the single source of truth for conversation state. The hypergraph is derived from the event stream by the reducer. Every streamed event becomes a chunk node (content events) or a structural edge (graph-structural events) in the graph — there is no separate streaming buffer. The graph is the streaming state; the event stream is the persistent history.

The hypergraph replaces:
- The agent harness's mutable `Message[]`
- The client-side event `Graph`, `reduceEvent`, and `projectMessages`
- The distinction between "streaming state" and "conversation state"

The hypergraph does NOT replace:
- Provider harnesses — they still exist, but now receive the graph like all harnesses and project to `Message[]` internally as their first step
- The SSE transport — events still flow over SSE, but the client adds them as chunk nodes to the graph rather than building a separate event graph

## Streaming Reduction

The reducer transforms a stream of `HarnessEvent`s into graph operations. Both the server (canonical) and client (replica) run the same reducer. All boundary detection logic lives in the reducer — harnesses emit raw events, the server is a passthrough, and the reducer decides when blocks and messages start and end.

### Block Boundaries

Block identity is determined by the event's `id` field. Provider harnesses pre-assign a stable `id` per content stream within a single LLM call (e.g., one `textId` for all text deltas, one `reasoningId` for all reasoning deltas). Tool calls get their `id` from the LLM API; tool results reuse the tool call id with a `:result` suffix.

When a chunk event arrives:

1. **New `id`** — start a new block:
   - `addNode` for the chunk
   - `addNode` for the block (content-free aggregation point)
   - `addEdge("block", { part: [chunkId], whole: [blockId] })`
   - `addEdge("sequence", ...)` linking the chunk to the previous chunk, and the block to the previous block
2. **Same `id` as current block** — extend the block:
   - `addNode` for the chunk
   - `extendEdge` to append the chunk to the block edge's `part` list
   - `addEdge("sequence", ...)` linking the chunk to the previous chunk

### Message Boundaries

Message boundaries are detected by the reducer using the same logic as the current `projectMessages()`:

- **Role transition** — a `user` event after assistant content (or vice versa) closes the current message and starts a new one
- **Text after tool results** — text content appearing after tool_result blocks signals a new assistant turn
- **`harness_end`** — closes the current message (the harness invocation is complete)

When a message boundary is detected:

1. `addNode` for the message (content-free aggregation point)
2. `addEdge("message", { part: [blockIds...], whole: [messageId] })` grouping all blocks since the last boundary
3. `addEdge("sequence", ...)` linking the message to the previous message

### Summarization Flow

Summarization is an LLM call like any other. The agent selects source messages, sends them to a provider harness with a summarization prompt, and the response streams back as chunk events. These chunks flow through the normal reduction pipeline — creating chunk nodes, block edges, and eventually a message node. When the summarization completes, the harness emits a structural event:

```typescript
{ type: "summary_created", sourceIds: ["msg_3", "msg_4", "msg_5"], resultId: "summary_msg" }
```

The reducer processes this like any other event — creating the summary edge and positioning sequence edges:

1. Normal reduction: chunks → blocks → message node (the summary)
2. `summary_created` event arrives
3. `addEdge("summary", { source: [sourceMessageIds...], result: [summaryMessageId] })`
4. `addEdge("sequence", ...)` to position the summary as a parallel path (see [Parallel Paths](#parallel-paths))
5. Update active set: remove source message ids, add summary message id

The summary message's content is derived from its chunks like any other message — no special content storage. The `summary_created` event is persisted in the event stream alongside content events, so replay reconstructs the summary edge.

### Graph-Structural Events

Most events are content events (HarnessEvents — text, reasoning, tool_call, etc.) that produce chunk nodes. A small number of events are graph-structural — they don't produce chunks but create edges or modify graph topology:

- **`summary_created`** — creates a summary edge linking source messages to a summary message. Emitted by the harness after a summarization LLM call completes.

Branching does **not** need a structural event. When a user edits a message or the agent retries, new chunks stream in, the reducer creates new nodes, and the sequence edge from the predecessor to the new message creates the fork implicitly. The branch exists because the graph has two paths.

The active set is **ephemeral view state** — like scroll position, each client builds it from `defaultActive` on load and customizes locally. The graph structure (which summaries exist, which branches exist) is persistent; which one a client is looking at is not.

## Persistence

The event stream — the ordered sequence of all events (content and structural) — is the single persistence artifact. The graph is always derived by replaying events through the reducer. There is no separate graph serialization.

```
Persist:  [event_1, event_2, ..., event_N]  (append-only)
Load:     replay(events) → graph            (deterministic)
Resume:   events[N+1..]                     (client reconnection)
```

This works because:
- **Content events** (HarnessEvents) produce chunk nodes, block/message nodes, and composition edges via the reducer
- **Structural events** (`summary_created`) produce summary edges and positioning sequence edges via the reducer
- The reducer is deterministic — same events, same graph
- The event stream is append-only — new events are appended, old events are never modified

**Snapshots** are an optional load-time optimization. A snapshot is a serialized graph at a point in time. On load: deserialize the latest snapshot, then replay only events after the snapshot. Not architecturally necessary, but avoids replaying the full event stream for long conversations.

**Client reconnection** uses event sequence numbers. The client tracks the last event it processed. On reconnect, it requests events after that sequence number and feeds them through the reducer to catch up.

### Open Questions

1. **Node content shape** — Decided: discriminated union with `kind: "chunk" | "block" | "message"`. Only chunk nodes store content (`HarnessEvent`). Block and message nodes are content-free aggregation points — their `ViewContent` and `Message` are derived on demand from their children via composition edges. No separate `"summary"` kind — summary nodes are message nodes that participate in a summary edge, and their content is derived from chunks produced by the summarization LLM call. Detection via `findEdges(graph, { type: "summary", node: id, role: "result" })`.
   - *Status: Decided*

2. **Harness interface** — Decided: the graph replaces `messages` in `GeneratorInvokeParams`. All harnesses receive `graph: ConversationGraph` and `active: Set<NodeId>`. Provider harnesses project to `Message[]` as their first step and ignore the graph structure. Agent harnesses can traverse the graph for loop decisions (e.g., context pressure, summarization). How the agent exposes graph traversal to the LLM (tools, system prompt, etc.) is an implementation choice left to each agent harness — not prescribed by the interface.
   - *Status: Decided*

3. **End-to-end data flow** — Decided: server owns the canonical event stream. On request: replay events into graph → add user message node → pass graph to harness → harness yields events → server appends each event to the stream, reduces into graph, and streams to client over SSE. Client runs the same reducer to build its own graph copy. The client graph is a replica — same reducer, same events, same result.
   - *Status: Decided*

4. **Chunk-level sequence edges** — Decided: chunks have sequence edges in arrival order (matching current HarnessEvent stream order). Block edges group same-type consecutive chunks into content blocks. The four-level hierarchy (chunk → block → message → summary) with sequence edges at every level fully addresses ordering.
   - *Status: Decided*

5. **Subagent/spawn edges** — Decided: dedicated `spawn` edge type with roles `{ trigger, invocation }`. Represents causation — a tool_call triggered a harness invocation. Not subagent-specific; any tool-triggered harness invocation gets a spawn edge. Root harness invocations (triggered by user messages) use sequence edges at the message level, not spawn edges. Replaces the current `runId`/`parentId` cross-run edge convention.
   - *Status: Decided*

6. **Persistence** — Decided: the event stream (ordered sequence of content events + structural events) is the single persistence artifact. The graph is derived by replaying events through the reducer — no separate graph serialization. Snapshots (serialized graph at a point in time) are an optional load-time optimization. Active set is ephemeral client-side view state, not persisted — each client builds from `defaultActive` on load. Client reconnection uses event sequence numbers to resume from the last processed event.
   - *Status: Decided*

7. **Summarization triggers** — Decided: three trigger mechanisms, all calling the same `summarize()` graph operation. (a) User-initiated — user selects messages in the web client. (b) Agent-initiated — the LLM uses a graph tool to deliberately summarize a range. (c) Loop-level heuristic — agent harness detects context pressure before a provider call and summarizes automatically. Trigger is different, operation is the same.
   - *Status: Decided*

8. **Edge type extensibility** — Decided: closed TypeScript discriminated union. New edge types are deliberate design decisions that show up in the type system and force exhaustive handling. `HyperEdge` is a union of per-type variants (`SequenceEdge | BlockEdge | ...`), each with typed `roles`. Adding a new edge type means adding a variant to both `EdgeType` and `HyperEdge` with its specific roles, then handling it in switches — trivial refactor, full compiler safety, and no silent role mismatches.
   - *Status: Decided*

9. **Boundary detection and derived content** — Decided: block boundaries are id-based (event `id` field — provider harnesses pre-assign stable ids per content stream). Message boundaries are detected by the reducer using role transitions and text-after-tool-result patterns (same logic as existing `projectMessages()`). All boundary logic lives in the reducer — harnesses emit raw events, the server is a passthrough. Composition node content (block `ViewContent`, message `Message`) is derived on demand from chunks via composition edges, not stored. Edges grow monotonically during streaming (`extendEdge` appends chunks to block edges). Summarization produces normal chunks from an LLM call — no special content storage for summary nodes.
   - *Status: Decided*
