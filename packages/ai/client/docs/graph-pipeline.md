# Graph Pipeline

This document explains how events flow through the client pipeline: from raw ServerEvents to the conversation Graph, then to projected views for rendering and API calls.

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

## 2. Graph Reduction

The `reduceEvent(graph, event)` function (graph.ts:141-190) is a pure reducer that builds an immutable conversation graph.

### Node Creation

Each event becomes a Node (types.ts:7-24). Node id is derived from the event (graph.ts:38-73):

- Events with `id` field (text, reasoning, tool_call, relay) use that id directly
- `tool_result` shares the tool_call's id but adds `:result` suffix
- Lifecycle events (harness_start, harness_end, error) use `runId:event_type`
- Usage events have no stable id, so use a counter: `runId:usage:N`

### Streaming Append

Text and reasoning nodes **append** content when the same id appears again:

```typescript
// graph.ts:155-165
if (existingNode && event.type === "text" && existingNode.kind === "text") {
  nodes.set(nodeId, {
    ...existingNode,
    content: existingNode.content + event.content
  });
  return { nodes, edges, lastNodeByRunId }; // No new edges
}
```

This handles streaming — multiple events with the same id accumulate into one node.

### Edge Construction

Edges form a directed graph:

1. **Sequential edges**: Connect consecutive events in the same run. Tracked by `lastNodeByRunId` (graph.ts:182-184).

2. **Cross-run edges**: Connect a tool_call (parent) to the first event in the spawned subagent run (child). Created when a new run's first event has a `parentId` (graph.ts:177-179).

Example:

```
user:1 → text:2 → tool_call:3 → tool_result:3:result
                       ↓
                  harness_start:child → text:child:1 → harness_end:child
```

- `user:1 → text:2 → tool_call:3 → tool_result:3:result` are sequential edges in the main run
- `tool_call:3 → harness_start:child` is a cross-run edge (parentId = tool_call:3)
- `harness_start:child → text:child:1 → harness_end:child` are sequential edges in the child run

## 3. Conversation State

`reduceConversation(state, event)` (conversation.ts:45-91) wraps graph reduction with:

- `sessionId` — from "connected" event
- `pendingRelays` — relay events awaiting user approval
- `isConnected` — SSE connection status

It delegates graph building to `reduceEvent()` and tracks higher-level state.

## 4. Thread Projection

`projectThread(graph)` (projections/thread.ts:266-280) walks the graph depth-first from roots (nodes with no incoming edges) and produces a flat `ViewNode[]` for UI rendering.

### ViewNode Structure

Each ViewNode (thread.ts:23-30) represents a renderable chunk:

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

### Walk Algorithm

The walk (thread.ts:125-253) follows edges:

1. Start at a root node
2. For each node:
   - Convert to ViewContent (thread.ts:76-105)
   - Separate edges into **continuation** (same-run) and **branches** (cross-run)
   - If node is tool_call, recurse on branches to build nested `ViewNode[][]`
   - Merge consecutive text/reasoning nodes in the same run
   - Attach tool_result output back to the matching tool_call ViewNode

3. Special case: tool_result nodes don't create their own ViewNode. Instead, their output is attached to the corresponding tool_call ViewNode (thread.ts:237-246).

4. Special case: harness_start with no continuation (subagent just spawned, still streaming) emits a "pending" placeholder (thread.ts:219-233).

### Branch Nesting

Subagent runs appear as nested `branches` on the tool_call that spawned them:

```typescript
// tool_call ViewNode
{
  content: { kind: "tool_call", name: "agent", input: { task: "..." } },
  branches: [
    [ /* ViewNode[] for the subagent run */ ]
  ]
}
```

This allows UIs to render subagent work as nested conversation threads.

## 5. Messages Projection

`projectMessages(graph)` (projections/messages.ts:20-79) transforms the graph into the LLM API `Message[]` format for building follow-up requests.

### Algorithm

1. Call `projectThread(graph)` to get the flat ViewNode[] (excludes nested branches)
2. Walk the ViewNodes and accumulate:
   - `text` → assistant message content
   - `tool_call` → add to assistant's `tool_calls` array
   - `tool_call` with `output` → emit tool message with `tool_call_id` and serialized output
   - `user` → flush current assistant turn, emit user message

3. Flush accumulated content at turn boundaries (when switching from assistant to user or encountering tool_calls followed by new text).

### Output Format

```typescript
[
  { role: "user", content: "..." },
  {
    role: "assistant",
    content: "...",
    tool_calls: [{ id: "...", name: "...", arguments: {...} }]
  },
  {
    role: "tool",
    tool_call_id: "...",
    content: "..."
  },
  ...
]
```

Reasoning, error, relay, and pending nodes are excluded — only user/assistant/tool messages are included.

## 6. Usage Example

```typescript
import { stream } from "./transports/sse";
import { reduceConversation, createInitialConversation } from "./conversation";
import { projectThread } from "./projections/thread";

let state = createInitialConversation();

for await (const event of stream("/api/chat", { message: "Hello" })) {
  state = reduceConversation(state, event);

  // Render thread view
  const viewNodes = projectThread(state.graph);
  console.log(viewNodes);
}
```

The client maintains immutable state by folding events through the reducers, then projects that state into different formats for rendering or API calls.
