# Hypergraph

The active conversation graph model. Events are reduced into a three-tier node hierarchy connected by typed hyperedges.

## Architecture

**Node hierarchy:** chunk → block → message

**Edge types:** `sequence` (predecessor/successor), `block` (part/whole), `message` (part/whole), `summary` (source/result), `spawn` (trigger/invocation)

### Core

- `types.ts` — `ConversationGraph { nodes, edges }`. Nodes are `chunk | block | message`. Edges are typed with role maps.
- `primitives.ts` — Low-level graph ops: `createGraph`, `addNode`, `addEdge`, `extendEdge`, `getNode`, `findEdges`.
- `reducer.ts` — `reduceEvent(graph, state, event) → [graph, state]`. Separate `ReducerState` tracks per-run block/chunk cursors and message boundary detection.
- `conversation.ts` — `reduceConversation(state, event)` wraps the reducer with session/relay/connection state and recomputes the active set on each event.
- `walk.ts` — Active-set navigation: `defaultActive`, `fullHistoryActive`, `walk`, `findHead`, `findNextActive`, `findPrevActive`, `descendToFirstActive`, `findAggregate`, `validate`.
- `operations.ts` — Active-set mutations: `expand`, `collapse`, `append`, `summarize`, `branch`, `toggle`. `toggle` adds/removes a node without structural checks.
- `queries.ts` — Traversal: `chunksOf`, `blocksOf`, `sourcesOf` (downward); `blockOf`, `messageOf`, `summariesOf` (upward).
- `derived.ts` — `deriveBlockContent`, `deriveMessageContent` — extracts semantic content from nodes by inspecting their chunks.

### Projections (`projections/`)

Three projections for chat UI, LLM API messages, and 2D graph visualization. See `projections/CLAUDE.md` for details and gotchas.

## Testing

```bash
bun test packages/ai/client/hypergraph/
```

## Gotchas

- `primitives.ts` maintains a `nodeIndex` (node→edge lookup) alongside the graph, but hides it from the `ConversationGraph` type via `as ConversationGraph` casts — internally all primitives work with `IndexedGraph`, bootstrapped by `ensureIndexed()` on first call

## Docs

- `docs/reduction.md` — ReducerState internals, reduction steps, block key derivation, conversation state
- `../docs/graph-pipeline.md` — High-level pipeline overview: events → reduction → active set → projections
