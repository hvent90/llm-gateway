# Graph Pipeline

How events become UI. The client transforms a flat stream of server events into a conversation graph, then projects that graph into view-specific formats.

```
SSE stream → reduceEvent() → Graph → projectThread() → ViewNode[]
                                    → projectMessages() → Message[]
```

## Graph Structure

The `Graph` (`client/types.ts`) has three maps:

- **nodes** — `Map<id, Node>`. Each node is one content block (text, tool_call, tool_result, etc.), not one "message." Keyed by a deterministic id derived from the event.
- **edges** — `Map<sourceId, targetId[]>`. Adjacency list representing sequencing and parent-child relationships.
- **lastNodeByRunId** — `Map<runId, nodeId>`. Tracks the most recent node per run so the reducer knows where to attach the next edge.

Nodes carry a `kind` discriminant plus kind-specific fields. The full union is in `client/types.ts:7`.

## Building the Graph: reduceEvent

`reduceEvent` (`client/graph.ts:141`) is a pure function: `(Graph, GraphEvent) → Graph`. Every call returns a new graph (maps are shallow-cloned for immutability).

### Node identity

`deriveNodeId` maps each event to a stable string id. Most content events use their own `id` field. Lifecycle events are keyed as `{runId}:harness_start`, tool results as `{id}:result`, usage events get a counter suffix. `connected` events return null and are skipped.

### Edge construction

Two kinds of edges get created:

1. **Sequential edges** — When a run already has a previous node (`lastNodeByRunId`), an edge is added from that previous node to the new one. This chains events within a single harness invocation.

2. **Cross-run edges** — When the first event in a run carries a `parentId`, an edge is added from `parentId` to the new node. This links a subagent's first event back to the tool_call that spawned it.

After adding the node and edges, `lastNodeByRunId` is updated to point at the new node.

### Streaming append

Text and reasoning events arrive as incremental chunks sharing the same `id`. When `reduceEvent` sees a text/reasoning event whose node already exists, it appends the content string rather than creating a new node. No new edges are added — the node was already wired in on first arrival.

## Session State: reduceConversation

`reduceConversation` (`client/conversation.ts:45`) wraps the graph reducer with session-level concerns:

- **sessionId** — Set on `connected` events from the SSE transport.
- **isConnected** — Toggled by synthetic `stream_start`/`stream_end` events.
- **pendingRelays** — Accumulated from `relay` events, removed on `relay_resolved`. These represent permission requests waiting for user action.

Most event types pass through to `reduceEvent` unchanged. The conversation reducer handles the lifecycle bookkeeping that doesn't belong in the graph.

## Projection: projectThread

`projectThread` (`client/projections/thread.ts:266`) transforms the graph into `ViewNode[]` for a threaded chat UI. This is where the graph's flat node/edge structure becomes a nested, renderable tree.

### Algorithm

1. **Find roots** — nodes with no incoming edges, in insertion order.
2. **Walk each root** via `walkRun`, which follows edges forward from a starting node.
3. At each node, edges are classified:
   - **Same-run** target → continuation (follow sequentially)
   - **Cross-run** target → branch (recurse into nested `ViewNode[]`)
4. When there's no same-run continuation but cross-run edges exist, the first cross-run edge is promoted to continuation (e.g., user message → assistant reply). Exception: `tool_call` nodes never promote — they wait for a same-run `tool_result`.

### Content filtering

Structural nodes (`harness_start`, `harness_end`, `usage`, `tool_result`) produce no ViewNode. They're invisible in the output. `tool_result` is special — its `output` is attached back to the corresponding `tool_call` ViewNode instead.

### Merging and nesting

- Consecutive text or reasoning nodes in the same run are merged into one ViewNode.
- Subagent branches appear as entries in the parent `ViewNode.branches` array, nested under the tool_call that spawned them.
- A `harness_start` with no continuation yet emits a `{ kind: "pending" }` placeholder so the UI can show a spinner.

### Run status

Each ViewNode gets a `status` derived from the graph: `"streaming"` if `harness_start` exists but no `harness_end`, `"error"` if an error node exists, `"complete"` otherwise.

## Projection: projectMessages

`projectMessages` (`client/projections/messages.ts:20`) converts the graph into LLM API `Message[]` for building follow-up requests. It calls `projectThread` internally and walks the flat ViewNode list (branches excluded):

- **user** nodes → `{ role: "user" }` messages
- **text** nodes → accumulated into `{ role: "assistant", content }` messages
- **tool_call** nodes → accumulated into `tool_calls` array on the assistant message
- **tool_result** output → `{ role: "tool" }` messages following the assistant message

Reasoning, error, relay, and pending nodes are skipped — they aren't part of the LLM conversation history.

## Transport: SSE

`createSSETransport` (`client/transports/sse.ts:45`) provides the `stream()` async generator that feeds events into the pipeline. It POSTs a `StreamRequest` to the server, reads the response body as a stream, parses SSE frames (`data: {json}\n\n`), and yields `ServerEvent` objects. Incomplete frames are buffered across chunks.

## Edge Cases

**Interleaved subagent events** — During parallel subagent execution, events from different `runId`s arrive interleaved over the single SSE connection. The reducer handles this correctly because `lastNodeByRunId` tracks each run independently, and edges are always scoped to the correct run.

**Streaming text across chunks** — A single text node may arrive as dozens of tiny `text` events. The reducer's append path ensures these coalesce into one node, and `projectThread`'s merge path ensures consecutive text nodes (if they somehow got separate ids) also coalesce into one ViewNode.

**tool_call without tool_result yet** — During streaming, tool_call nodes exist before their results arrive. `projectThread` renders them with `output: undefined`. The tool_call node doesn't promote cross-run edges, so a subagent branch nests correctly even before the tool_result arrives.

**Deep nesting** — Subagents spawning subagents works recursively. Each level introduces a new `runId` with a `parentId` pointing to its spawning tool_call. `walkRun` recurses naturally through these cross-run edges.
