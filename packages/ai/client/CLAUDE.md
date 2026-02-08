# Client

## Why

Client-side state management for UIs that consume harness events. Transforms a flat event stream into a conversation graph, then projects it into different view formats.

## What

Core modules:

- `graph.ts` — Pure reducer: `reduceEvent(graph, event)` produces immutable Graph from events. Nodes derived from events, edges from runId/parentId relationships. Text/reasoning events append (streaming).
- `conversation.ts` — Higher-level reducer wrapping graph + sessionId + pendingRelays + connection state.
- `types.ts` — Graph and Node type definitions. Graph has nodes (Map), edges (adjacency list), lastNodeByRunId (for edge building).

Projections:

- `projections/thread.ts` — Projects graph into flat `ViewNode[]` for threaded chat UI. Merges text deltas, attaches tool results to tool calls, nests subagent branches.
- `projections/messages.ts` — Projects graph into LLM API `Message[]` format for building follow-up requests.

Transports:

- `transports/sse.ts` — SSE transport: `stream()` returns `AsyncIterable<ServerEvent>`. Handles EventSource lifecycle.
- `transports/http.ts` — HTTP transport: `resolveRelay()` sends permission decisions back to server.

Wire format:

- `server-event.ts` — ServerEvent type definitions (wire format of ConsumerHarnessEvent).

## How

Events arrive via SSE → `reduceConversation()` folds them into a Graph → projections transform the graph into views. `projectThread()` produces `ViewNode[]` for chat UIs, `projectMessages()` produces `Message[]` for API calls.

See also: `packages/ai/harness/CLAUDE.md` for the event-producing side of this pipeline.

## Docs

→ `docs/graph-pipeline.md` — Detailed walk-through of event → graph → projection pipeline
