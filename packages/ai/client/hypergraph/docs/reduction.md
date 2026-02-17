# Graph Reduction

`reduceEvent(graph, state, event)` (see `reducer.ts`) is a pure reducer that returns `[ConversationGraph, ReducerState]`.

## ReducerState

Separate from the graph, tracks per-run cursors:

- `lastChunkByRunId` / `lastBlockByRunId` — for building sequence edges
- `currentBlockIdByRunId` / `currentBlockEdgeByRunId` — for grouping chunks into blocks
- `pendingBlocksByRunId` — blocks waiting to be flushed into a message
- `hadToolResultSinceLastText` — message boundary detection
- `lastMessageId` / `messageCounter` — message sequencing
- `chunkCounter` — monotonic ID generator for chunk nodes
- `eventIdToBlockNodeId` — maps raw event ID → block node ID for spawn edge resolution

## Reduction Steps

For each event:

1. **Create chunk node** — every event becomes a chunk
2. **Chunk sequence edge** — links to previous chunk in same run
3. **Block grouping** — events with same `blockKey` extend the current block; new keys create a new block with its own block edge
4. **Spawn edge** — first event in a run with `parentId` creates a spawn edge from parent block to first chunk
5. **Message boundary** — blocks flush into messages at: user events (immediate), `harness_end`, or text-after-tool-result boundaries

## Block Key Derivation

The `blockKey` determines which chunks group together:

- `text`, `reasoning` — use `runId:id` (runId-scoped so streaming deltas accumulate)
- `tool_call`, `relay`, `tool_progress` — use the event's `id`
- `tool_result` — `id:result` suffix (separate block from the tool_call)
- Lifecycle events — `runId:event_type`
- `user` — `runId:user`

## Conversation State

`reduceConversation(state, event)` (see `conversation.ts`) wraps graph reduction with:

- `sessionId` — from "connected" event
- `pendingRelays` — relay events awaiting user approval
- `isConnected` — SSE connection status
- `active` — `Set<NodeId>` of currently visible messages, recomputed via `defaultActive()` after each event
- `reducerState` — the ReducerState passed through to the graph reducer
