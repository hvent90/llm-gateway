# Subagents

Subagents are agent harness invocations spawned by a tool call. They stream in parallel with the parent agent and can use tools, request permissions, and spawn their own subagents.

## How it works

The LLM has access to an `agent` tool with schema `{ task: string }`. When it calls this tool, the orchestrator spawns a new agent harness with the same model, tools, and permissions. The subagent runs its full agentic loop independently. Its events stream to the client through the same SSE connection, tagged with a distinct `agentId`. When the subagent finishes, its final text becomes the tool result for the parent.

If the LLM emits multiple `agent` tool calls in a single response, all subagents run concurrently.

## Graph structure

The conversation graph is a tree of nodes linked by `runId` and `parentId`. Subagents introduce no new concepts — a subagent is just another node whose `parentId` is the `toolCallId` that spawned it.

```
root-agent (runId: "a1", no parentId)
  ├─ text "I'll search and analyze..."
  ├─ tool_call id:"tc-1" name:"agent" input:{task:"search for X"}
  │   └─ subagent (runId: "a2", parentId: "tc-1")
  │       ├─ text "Searching..."
  │       ├─ tool_call id:"tc-3" name:"bash" input:{command:"grep ..."}
  │       ├─ tool_result id:"tc-3" output:{...}
  │       └─ text "Found X, Y, Z"
  ├─ tool_result id:"tc-1" output:"Found X, Y, Z"
  ├─ tool_call id:"tc-2" name:"agent" input:{task:"analyze Y"}
  │   └─ subagent (runId: "a3", parentId: "tc-2")
  │       ├─ text "Analyzing..."
  │       └─ text "Analysis shows..."
  ├─ tool_result id:"tc-2" output:"Analysis shows..."
  └─ text "Based on the search and analysis..."
```

Key relationships:

- The subagent's `parentId` is the `tool_call.id` that spawned it, not the parent agent's `runId`.
- The `tool_result` for the `agent` tool call contains the subagent's final text — the same content the subagent produced in its last response.
- Subagents can nest arbitrarily. A subagent spawning its own subagent produces the same structure recursively.

## Events on the wire

All events arrive over the single SSE connection. Each event carries `runId`, `agentId`, and optionally `parentId`. The event types are the same as any agent — `text`, `reasoning`, `tool_call`, `tool_result`, `relay`, `error`. There are no subagent-specific event types.

During parallel subagent execution, events from different agents interleave freely. The `agentId` field identifies which agent produced each event. The `runId` identifies the harness invocation (and maps to graph nodes). For subagents, `runId` and `agentId` differ from the parent's.

Example SSE stream with two parallel subagents:

```
event: tool_call
data: {"id":"tc-1","runId":"a1","agentId":"agent-1","name":"agent","input":{"task":"search"}}

event: tool_call
data: {"id":"tc-2","runId":"a1","agentId":"agent-1","name":"agent","input":{"task":"analyze"}}

event: text
data: {"id":"e1","runId":"a2","agentId":"agent-2","parentId":"tc-1","content":"Searching..."}

event: text
data: {"id":"e2","runId":"a3","agentId":"agent-3","parentId":"tc-2","content":"Analyzing..."}

event: text
data: {"id":"e3","runId":"a2","agentId":"agent-2","parentId":"tc-1","content":"Found results"}

event: text
data: {"id":"e4","runId":"a3","agentId":"agent-3","parentId":"tc-2","content":"Analysis complete"}

event: tool_result
data: {"id":"tc-1","runId":"a1","agentId":"agent-1","name":"agent","output":{...}}

event: tool_result
data: {"id":"tc-2","runId":"a1","agentId":"agent-1","name":"agent","output":{...}}

event: text
data: {"id":"e5","runId":"a1","agentId":"agent-1","content":"Based on both results..."}
```

## Client rendering

The existing graph reducer, selectors, and rendering primitives handle subagents without modification.

### Graph reducer

`reduceEvent` in `packages/ai/client/graph.ts` processes each event by its `runId`. Subagent events create new nodes automatically because they carry a new `runId` with a `parentId` pointing to the spawning tool call.

### Selectors

All selectors in `packages/ai/client/selectors.ts` work on subagent nodes identically to parent nodes:

| Selector | Behavior with subagents |
|----------|------------------------|
| `getRoots(graph)` | Returns only the top-level agent. Subagents are never roots (they have a `parentId`). |
| `getChildren(graph, runId)` | Returns child nodes. When called with a tool call ID as `runId`, returns the subagent node. |
| `getText(graph, runId)` | Returns concatenated text for any node, including subagent nodes. |
| `getContentBlocks(graph, runId)` | Returns content blocks for any node. For the parent, the `agent` tool call appears as a `tool_call` content block like any other tool. |
| `getToolCalls(graph, runId)` | Returns tool calls for any node. The parent's tool calls include `agent` calls alongside `bash` calls. |

### Rendering the subagent tree

`MessageNode` in `clients/web/src/components/MessageNode.tsx` already renders recursively: it calls `getChildren(graph, runId)` and renders child `MessageNode` components with increased depth. This means subagent content renders nested under the tool call that spawned it, with visual indentation.

However, there is a gap in the current rendering: `getChildren` is called with the node's `runId`, which finds children whose `parentId` matches that `runId`. But a subagent's `parentId` is a **tool call ID**, not a `runId`. So `getChildren(graph, parentRunId)` won't find the subagent — you need `getChildren(graph, toolCallId)`.

To render subagents nested under their tool calls, the UI should:

1. Render the parent node's content blocks normally.
2. For each `tool_call` content block where `name === "agent"`, check for children using `getChildren(graph, toolCall.id)`.
3. Render any child nodes (the subagent) nested under that tool call block.

```
┌─ Agent ─────────────────────────────────
│ I'll search and analyze...
│
│ ┌─ tool_call: agent("search for X") ──
│ │ ┌─ Subagent ─────────────────────────
│ │ │ Searching...
│ │ │ ┌─ tool_call: bash("grep ...") ──
│ │ │ │ stdout: ...
│ │ │ └───────────────────────────────────
│ │ │ Found X, Y, Z
│ │ └────────────────────────────────────
│ └──────────────────────────────────────
│
│ ┌─ tool_call: agent("analyze Y") ─────
│ │ ┌─ Subagent ─────────────────────────
│ │ │ Analysis shows...
│ │ └────────────────────────────────────
│ └──────────────────────────────────────
│
│ Based on the search and analysis...
└─────────────────────────────────────────
```

### Streaming indicators

The `activeStreams` set in `ConversationState` tracks which `runId`s are currently receiving events. During subagent execution, the parent's `runId` stays in `activeStreams` (the SSE connection is still open), and each subagent's `runId` would need to be tracked separately if you want per-agent streaming indicators.

Currently, `stream_start` and `stream_end` are synthetic client-side events tied to the SSE connection lifecycle, not to individual agents. To show per-agent streaming state, the UI can check whether a node's most recent event is recent or whether the node has any pending tool calls without results.

### Permissions

Subagent permission requests (relay events) flow through identically to parent agent relays. The relay event carries the subagent's `runId` and the tool call it's requesting permission for. The existing `PermissionPrompt` rendering in `MessageNode` handles this — it checks `pendingRelays` for relays matching the current `runId`.
