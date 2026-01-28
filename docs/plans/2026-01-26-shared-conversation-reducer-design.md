# Shared Conversation Reducer

Consolidate duplicated event-to-message logic from the CLI and web clients into the `packages/ai/client` conversation module.

## Problem

Both clients independently:

1. Dispatch on `ServerEvent.type` to accumulate state
2. Track which `runId` is currently streaming
3. Merge consecutive text/reasoning content
4. Handle parent-child node relationships
5. Manage relay state and session ID

The ai package already has a graph reducer and selectors, but they operate on `HarnessEvent` (server-side type) and lack the features clients need.

## Design

### Graph as Conversation Tree

The graph becomes the full conversation tree, holding both user and assistant nodes.

```typescript
interface GraphNode {
  runId: string;
  parentId?: string;
  role: "user" | "assistant";
  events: Array<ServerEvent | UserEvent>;
}

type UserEvent = { type: "user"; content: string; timestamp: number };
```

User messages get client-generated `runId`s and a `parentId` pointing to the node they reply to. This supports branching conversations: a user can reply to any agent node (main or sub-agent), and multiple replies to the same node create parallel branches.

```
root
+-- user-1: "Hello"
|   +-- run-abc: "Hi! How can I help?"
|       +-- user-2: "Tell me about X"   (branch 1)
|       |   +-- run-def: "X is..."
|       +-- user-3: "Tell me about Y"   (branch 2)
|           +-- run-ghi: "Y is..."
```

### ConversationState

```typescript
interface ConversationState {
  graph: GraphState;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;    // runIds currently streaming
}

interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}
```

### Event Union

```typescript
type ConversationEvent =
  | ServerEvent
  | { type: "user"; runId: string; parentId?: string; content: string; timestamp?: number }
  | { type: "stream_start"; runId: string }
  | { type: "stream_end"; runId: string }
  | { type: "relay_resolved"; relayId: string; tool: string; approved: boolean };
```

### Reducer

| Event | Action |
|-------|--------|
| `connected` | Set `sessionId` |
| `text`, `reasoning`, `tool_call`, `tool_result`, `error` | Delegate to graph reducer |
| `relay` | Append to `pendingRelays` |
| `user` | Create user node in graph |
| `stream_start` | Add `runId` to `activeStreams` |
| `stream_end` | Remove `runId` from `activeStreams` |
| `relay_resolved` | Remove from `pendingRelays`; if approved, add `tool` to `grantedTools` |

`stream_start`/`stream_end` are dispatched by the client when it starts/finishes consuming the SSE stream. They are not wire events.

### Selectors

Pure functions that derive display data from `ConversationState`.

**Tree traversal:**
- `getRoots(state)` -- `runId[]` of nodes without `parentId`
- `getChildren(state, runId)` -- `runId[]` of nodes whose `parentId` matches
- `getRole(state, runId)` -- `"user" | "assistant"`

**Content:**

```typescript
type ContentBlock =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; output?: unknown }

function getContentBlocks(state: GraphState, runId: string): ContentBlock[]
```

Walks the node's events in order:
1. Merges consecutive `text` events into one `{ type: "text" }` block
2. Merges consecutive `reasoning` events into one `{ type: "reasoning" }` block
3. Creates `{ type: "tool_call" }` blocks, attaching `output` from matching `tool_result` events
4. For user nodes, returns `[{ type: "text", content }]`

This replaces the web client's `appendOrCreateBlock` + `handleEvent` switch, and the CLI's `isReasoning` tracking + message splitting.

**Status:**
- `isNodeStreaming(state, runId)` -- checks `activeStreams`
- `getNodeStatus(state, runId)` -- `"streaming" | "complete" | "error"`

**Session:**
- `getSessionId(state)` -- `string | null`
- `getPendingRelays(state)` -- `PendingRelay[]`
- `getGrantedTools(state)` -- `Set<string>`

### Graph Reducer: Switch to ServerEvent

The graph reducer currently accepts `HarnessEvent`. It switches to accept `ServerEvent` (the wire type clients receive). The differences:

- `connected` is ignored by the graph (handled by conversation reducer)
- `error` carries `message: string` instead of `error: Error`
- `relay` has no `respond` callback

This is appropriate since the graph + conversation module is a client-side helper.

## Client Integration

### Web Client

`clients/web/src/state/conversation.ts` is replaced entirely. The web client:

1. Imports `createInitialConversation`, `reduceConversation` from the ai package
2. Stores `ConversationState` in React state
3. On each `ServerEvent`, dispatches through the shared reducer
4. Renders by walking `getRoots` -> `getChildren` -> `getContentBlocks`

The web-specific `ConversationState`, `MessageNode`, and `ContentBlock` types are removed. The ai package's types are used directly.

### CLI Client

The `handleEvent` function and local `{ currentMsgId, isReasoning }` state tracking are removed. Instead:

1. Import the shared reducer
2. Maintain `ConversationState` in a Solid signal
3. On each SSE event, reduce through the shared reducer
4. Render by walking `getRoots` -> `getChildren` -> `getContentBlocks`
5. `MessageView` reads from `getContentBlocks(runId)` and renders block types appropriately

### What Each Client Still Owns

- Rendering / UI components
- Input handling
- Stream lifecycle (calling transport, dispatching `stream_start` / `stream_end`)
- Relay resolution UI (permission prompt display, user input parsing)

### What Moves to the ai Package

- All event-to-state logic (the reducer)
- All state-to-display-data logic (the selectors)
- `ContentBlock`, `ConversationState`, `PendingRelay` types
