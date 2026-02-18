# Client

## Why

Client-side state management for UIs that consume harness events. Transforms a flat event stream into a conversation hypergraph, then projects it into different view formats.

## What

### Hypergraph (`hypergraph/`)

The active graph model. Three-tier node hierarchy (chunk → block → message) connected by typed hyperedges, with projections for chat UI, API messages, and graph visualization. See `hypergraph/CLAUDE.md` for details.

### Legacy (`graph.ts`, `types.ts`)

Old flat graph model with adjacency-list edges and `reduceEvent(graph, event)`. Still exported from `client/index.ts` but no longer used by web client — `ConversationThread.tsx` and `GraphView.tsx` import from `hypergraph/`.

### Transports

- `transports/sse.ts` — SSE transport: `stream()` returns `AsyncIterable<ServerEvent>`.
- `transports/http.ts` — HTTP transport: `resolveRelay()` sends permission decisions back to server.

### Wire format

- `server-event.ts` — ServerEvent type definitions (wire format of ConsumerHarnessEvent).
- `progress.ts` — `accumulate()` for tool progress state.

## How

Events arrive via SSE → `reduceConversation()` folds them through the hypergraph reducer → active set computed via `defaultActive()` → projections transform the graph into views. `projectThread()` produces `ViewNode[]` for chat UIs, `projectMessages()` produces `Message[]` for API calls, `projectDAG()` produces `DAGLayout` for graph visualization.

See also: `../harness/CLAUDE.md` for the event-producing side, and `docs/graph-pipeline.md` for the full pipeline walkthrough.
