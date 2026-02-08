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

The pipeline:

1. Events arrive via SSE transport (transports/sse.ts)
2. `reduceConversation()` folds each event into ConversationState (conversation.ts:45-91)
3. Inside, `reduceEvent()` builds the Graph (graph.ts:141-190):
   - Sequential events in same run get sequential edges
   - First event in child run gets cross-run edge from parentId
   - Text/reasoning with same id append content (streaming)
4. `projectThread(graph)` transforms graph into ViewNode[] (projections/thread.ts:266-280):
   - Walks depth-first from roots
   - Groups sequential nodes by run
   - Subagent runs become nested `branches` on tool_call that spawned them
   - Filters out lifecycle nodes (harness_start/end, usage)
5. `projectMessages(graph)` transforms graph into Message[] for API calls (projections/messages.ts:20-79)

## Docs

→ `docs/graph-pipeline.md` — Detailed walk-through of event → graph → projection pipeline

## Tests

Tests in `__tests__/` folder cover graph reduction, projections, and transports.
