# Graph Pipeline

This document explains how events flow through the client pipeline: from raw ServerEvents to the conversation hypergraph, then to projected views for rendering, API calls, and graph visualization.

## 1. Events

ServerEvent types arrive from SSE transport (see `transports/sse.ts`). Each event has:

- `type` — identifies the event kind
- `runId` — identifies which agent run produced this event
- `parentId` (optional) — references the tool_call that spawned this run (for subagents)

Event types (see `server-event.ts`):

- `connected` — connection established, provides sessionId
- `text` — assistant text content (streams with multiple events sharing same `id`)
- `reasoning` — extended thinking content (streams like text)
- `tool_call` — LLM decided to call a tool
- `tool_result` — tool execution finished
- `harness_start` / `harness_end` — lifecycle events for agent runs
- `usage` — token usage stats
- `error` — error during execution
- `relay` — permission request waiting for user response
- `user` — user message (injected client-side, not from server)
- `tool_progress` — streaming progress from tool execution

## 2. Hypergraph Model

The conversation is represented as a `ConversationGraph` (see `hypergraph/types.ts`):

```typescript
type ConversationGraph = {
  nodes: Map<NodeId, ConversationNode>;
  edges: Map<EdgeId, HyperEdge>;
};
```

### Node Hierarchy

Three tiers of nodes, from finest to coarsest:

- **chunk** — A single event snapshot. `{ id, kind: "chunk", content: ChunkEvent }`
- **block** — Groups related chunks (e.g. all text deltas for one response). `{ id, kind: "block" }`
- **message** — Groups blocks into a logical turn. `{ id, kind: "message" }`

### Typed Hyperedges

Each edge has a `type` and typed `roles` mapping role names to arrays of node IDs:

| Edge Type | Roles | Purpose |
|-----------|-------|---------|
| `sequence` | `predecessor → successor` | Ordering between same-tier nodes |
| `block` | `part ↔ whole` | Chunks belong to a block |
| `message` | `part ↔ whole` | Blocks belong to a message |
| `summary` | `source → result` | Messages summarized by another |
| `spawn` | `trigger → invocation` | Subagent spawning |

## 3. Graph Reduction

`reduceEvent(graph, state, event)` (see `hypergraph/reducer.ts`) is a pure reducer that returns `[ConversationGraph, ReducerState]`.

### ReducerState

Separate from the graph, tracks per-run cursors:

- `lastChunkByRunId` / `lastBlockByRunId` — for building sequence edges
- `currentBlockIdByRunId` / `currentBlockEdgeByRunId` — for grouping chunks into blocks
- `pendingBlocksByRunId` — blocks waiting to be flushed into a message
- `hadToolResultSinceLastText` — message boundary detection
- `lastMessageId` / `messageCounter` — message sequencing
- `chunkCounter` — monotonic ID generator for chunk nodes

### Reduction Steps

For each event:

1. **Create chunk node** — every event becomes a chunk
2. **Chunk sequence edge** — links to previous chunk in same run
3. **Block grouping** — events with same `blockKey` extend the current block; new keys create a new block with its own block edge
4. **Spawn edge** — first event in a run with `parentId` creates a spawn edge from parent block to first chunk
5. **Message boundary** — blocks flush into messages at: user events (immediate), `harness_end`, or text-after-tool-result boundaries

### Block Key Derivation

The `blockKey` determines which chunks group together:

- `text`, `reasoning`, `tool_call`, `relay`, `tool_progress` — use the event's `id` (so streaming deltas accumulate)
- `tool_result` — `id:result` suffix (separate block from the tool_call)
- Lifecycle events — `runId:event_type`
- `user` — `runId:user`

## 4. Conversation State

`reduceConversation(state, event)` (see `hypergraph/conversation.ts`) wraps graph reduction with:

- `sessionId` — from "connected" event
- `pendingRelays` — relay events awaiting user approval
- `isConnected` — SSE connection status
- `active` — `Set<NodeId>` of currently visible messages, recomputed via `defaultActive()` after each event
- `reducerState` — the ReducerState passed through to the graph reducer

## 5. Active Set & Walking

The active set (see `hypergraph/walk.ts`) determines which messages are "visible" in the current view:

- `defaultActive(graph)` — all message nodes, minus those replaced by summaries
- `fullHistoryActive(graph)` — all message nodes regardless of summaries
- `walk(graph, active)` — generator that yields nodes in sequence order
- `findHead` / `findNextActive` / `findPrevActive` — navigation through sequence edges, climbing up/down the hierarchy when needed

### Operations (`hypergraph/operations.ts`)

- `expand(graph, active, nodeId)` — replace an aggregate with its constituents in the active set
- `collapse(graph, active, nodeIds)` — replace constituents with their aggregate
- `summarize(graph, active, sourceIds, summaryNode)` — create a summary edge and swap in active set
- `branch(graph, active, fromNodeId)` — walk active set up to a node (for branching)
- `append(graph, active, message)` — add a message at the tail with sequence edge
- `toggle(graph, active, nodeId)` — add/remove a node from the active set without structural checks

### Queries (`hypergraph/queries.ts`)

Downward traversal: `chunksOf(block)`, `blocksOf(message)`, `sourcesOf(summary)`
Upward traversal: `blockOf(chunk)`, `messageOf(block)`, `summariesOf(message)`

## 6. Thread Projection

`projectThread(graph)` (see `hypergraph/projections/thread.ts`) walks the hypergraph and produces a flat `ViewNode[]` for chat UI rendering.

Each ViewNode has:

```typescript
{
  id: string;
  runId: string;
  role: "user" | "assistant";
  content: ViewContent;  // text, reasoning, tool_call, user, error, relay, pending
  status: "streaming" | "complete" | "error";
  branches: ViewNode[][];  // Nested subagent runs
}
```

Key behaviors:

- **Tool result attachment** — `tool_result` chunks retroactively attach their output to the matching `tool_call` ViewNode (backward scan) rather than creating separate entries.
- **Tool progress accumulation** — `tool_progress` chunks accumulate into the matching `tool_call` ViewNode's `progress` field via `accumulate()` from `progress.ts`.
- **Subagent branches** — spawn edges produce nested `branches` arrays on the tool_call that triggered them.
- **Promotion logic** — when a chunk has no same-run continuation but has cross-run spawn targets, the first target is "promoted" from a branch to a continuation (inlined into the flat list) — unless the chunk is a `tool_call`, which always keeps spawns as branches.
- **Pending placeholder** — a `harness_start` with no continuation yet (subagent just spawned, no content) emits a `{ kind: "pending" }` ViewNode so the branch isn't discarded while streaming.

## 7. Messages Projection

`projectMessages(graph)` (see `hypergraph/projections/messages.ts`) transforms the hypergraph into LLM API `Message[]` format for building follow-up requests. Builds on `projectThread` — walks the flat `ViewNode[]` output (branches excluded) rather than traversing the graph directly. Excludes reasoning, error, relay, and pending nodes.

## 8. DAG Projection

`projectDAG(graph)` (see `hypergraph/projections/dag.ts`) produces `DAGLayout` for SVG graph visualization:

- **DAGNode[]** — one per block node. Block type derived from chunk content (text, reasoning, tool_call, tool_result, user, error, structural). Label extracted via `deriveBlockContent`. Each node has deterministic `x, y, width, height`.
- **DAGEdge[]** — block-to-block sequence edges + spawn edges (dashed). Cross-message sequences resolved from last-block → first-block.
- **DAGGroup[]** — message groups and summary groups as bounding boxes around their constituent nodes.

## 9. Usage Example

```typescript
import { createSSETransport } from "./transports/sse";
import { reduceConversation, createInitialConversation } from "./hypergraph";
import { projectThread } from "./hypergraph";
import { projectDAG } from "./hypergraph";

let state = createInitialConversation();
const transport = createSSETransport({ baseUrl: "" });

for await (const event of transport.stream(request, signal)) {
  state = reduceConversation(state, event);

  // Chat view
  const viewNodes = projectThread(state.graph);

  // Graph view
  const dagLayout = projectDAG(state.graph);
}
```

The client maintains immutable state by folding events through the reducers, then projects that state into different formats for rendering or API calls.
