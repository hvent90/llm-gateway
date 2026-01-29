# Subagent UI Design

Wire up subagent rendering, streaming state, and interactivity in the web client.

## Context

Subagent events already stream to the frontend over SSE. The graph reducer creates nodes for subagent `runId`s with `parentId` set to the spawning tool call ID. However, the UI doesn't render subagent content because `MessageNode` only looks for children of a node's `runId`, not children of its tool call IDs.

## Changes

### 1. New harness events

Add `harness_start` and `harness_end` to `HarnessEvent` and `ServerEvent`.

**`packages/ai/types.ts`** — add to `HarnessEvent` union:

```ts
| { type: "harness_start"; runId: string; parentId?: string }
| { type: "harness_end"; runId: string; parentId?: string }
```

**`packages/ai/client/server-event.ts`** — add to `ServerEvent` union:

```ts
| { type: "harness_start"; runId: string; agentId: string; parentId?: string }
| { type: "harness_end"; runId: string; agentId: string; parentId?: string }
```

### 2. Agent harness emission

**`packages/ai/harness/agent.ts`**

Yield `harness_start` right after `myRunId` is assigned (before the loop):

```ts
yield tag({ type: "harness_start", runId: myRunId });
```

Yield `harness_end` before every `return` statement:
- Line ~67: error during iteration
- Line ~82: no tool calls (normal completion)
- Line ~165: early return after executor error
- Line ~224: max iterations reached

```ts
yield tag({ type: "harness_end", runId: myRunId });
return assistantText;
```

### 3. Server serialization

**`server/index.ts`**

`serializeEvent` already spreads `{ ...event, agentId }` for non-error events. `harness_start` and `harness_end` carry `runId` and optional `parentId`, so they serialize correctly without changes.

### 4. Conversation state

**`packages/ai/client/conversation.ts`**

Split SSE connection state from per-agent streaming state:

```ts
interface ConversationState {
  graph: GraphState;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;  // harness-level: runIds from harness_start/harness_end
  isConnected: boolean;        // SSE connection: from stream_start/stream_end
}
```

Reducer changes:
- `stream_start` → set `isConnected: true` (stop adding to `activeStreams`)
- `stream_end` → set `isConnected: false`
- `harness_start` → add `event.runId` to `activeStreams`
- `harness_end` → remove `event.runId` from `activeStreams`

### 5. Graph reducer

**`packages/ai/client/graph.ts`**

No changes needed. `reduceEvent` already handles any event with a `runId` by getting-or-creating a node and appending the event. `harness_start` and `harness_end` will be appended to their node's event list.

### 6. Selectors

**`packages/ai/client/selectors.ts`**

Update `getStatus` to use harness events:

```ts
function getStatus(state: GraphState, runId: string): "streaming" | "complete" | "error" {
  const node = state.nodes.get(runId);
  if (!node) return "complete";

  const hasError = node.events.some((e) => e.type === "error");
  if (hasError) return "error";

  const hasEnd = node.events.some((e) => e.type === "harness_end");
  if (hasEnd) return "complete";

  const hasStart = node.events.some((e) => e.type === "harness_start");
  if (hasStart) return "streaming";

  return "complete";
}
```

### 7. MessageNode rendering

**`clients/web/src/components/MessageNode.tsx`**

For each `tool_call` content block, check for children using `getChildren(graph, block.id)`. If children exist, render them in a collapsible container.

This is not agent-specific logic — it applies to every tool call generically. Only `agent` tool calls will have child nodes in practice, but the code doesn't branch on tool name.

```tsx
function ToolCallBlock({
  block,
  graph,
  depth,
  pendingRelays,
  permissionHandlers,
  activeStreams,
}: {
  block: Extract<ContentBlock, { type: "tool_call" }>;
  graph: GraphState;
  depth: number;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
}) {
  const [expanded, setExpanded] = useState(true);
  const children = getChildren(graph, block.id);

  // ... existing input/output rendering ...

  {children.length > 0 && (
    <div>
      <button onClick={() => setExpanded(!expanded)}>
        {expanded ? "▼" : "▶"} {/* chevron toggle */}
      </button>
      {expanded && (
        <div className="mt-2 border-l-2 border-gray-600 pl-2">
          {children.map((childId) => (
            <MessageNode
              key={childId}
              graph={graph}
              runId={childId}
              depth={depth + 1}
              pendingRelays={pendingRelays}
              permissionHandlers={permissionHandlers}
              activeStreams={activeStreams}
            />
          ))}
        </div>
      )}
    </div>
  )}
}
```

The `ToolCallBlock` component needs additional props threaded through from `MessageNode` to support recursive rendering and streaming indicators.

### 8. App.tsx

**`clients/web/src/App.tsx`**

- Pass `activeStreams` through to `ConversationThread` → `MessageNode`
- Use `isConnected` instead of `activeStreams.size > 0` for disabling input:

```tsx
const isStreaming = state.isConnected;
```

### 9. Streaming indicators

`MessageNode` receives `activeStreams` and can check `activeStreams.has(runId)` to show a streaming indicator (e.g., a pulsing dot or "streaming..." text) next to the agent label. This works identically for parent agents and subagents.

## What's NOT changing

- Graph reducer logic — already handles arbitrary `runId`/`parentId` relationships
- Selectors (except `getStatus`) — `getChildren`, `getRoots`, `getContentBlocks` all work on subagent nodes already
- Permission flow — relay events carry the subagent's `runId` and render correctly
- No special-casing on tool name — subagent rendering is emergent from the graph structure
