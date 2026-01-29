# Children Container & Token Tracking Design

## Goal

Redesign the children container in `ToolCallBlock` to provide streaming-aware behavior (mini view during streaming, collapsed summary on completion) and add token usage tracking across the event pipeline.

## Principles

- Children containers are an emergent property of the graph: if `getChildren(graph, block.id)` returns nodes, the container renders. No branching on tool name.
- Relay prompts render inside child `MessageNode`s via the existing composable architecture. No special-casing.
- Token usage emitted per LLM call, aggregated by selectors.

## Architecture

Three workstreams, each buildable independently:

1. **Usage events** — new event type through the pipeline
2. **New selectors** — `getUsage`, `getToolCallCount`
3. **Container redesign** — streaming-aware children container in `ToolCallBlock`

## 1. Usage Event

### Type additions

`packages/ai/types.ts` — add to `HarnessEvent`:
```ts
| { type: "usage"; runId: string; parentId?: string; inputTokens: number; outputTokens: number }
```

`packages/ai/client/server-event.ts` — add to `ServerEvent`:
```ts
| { type: "usage"; runId: string; agentId: string; parentId?: string; inputTokens: number; outputTokens: number }
```

### Provider emission

Each provider harness yields a `usage` event after the streaming response completes (one per LLM call). An agent with 3 iterations emits 3 usage events.

Start with `zen.ts` (active test provider). Others can be added incrementally.

### Passthrough

- **Agent harness** (`agent.ts`): Pass through like text/reasoning — `yield tag(event)`.
- **Orchestrator**: No changes needed — already passes through all non-relay events.
- **Server serialization**: No changes — `serializeEvent` already spreads unknown event types with `{ ...event, agentId }`.
- **Graph reducer**: No changes — already stores all events on the node.
- **Conversation reducer**: Falls through to `default` case which delegates to graph reducer.

### SSE transport

No changes — already parses any JSON into `ServerEvent`.

## 2. Selectors

`packages/ai/client/selectors.ts`:

```ts
function getUsage(state: GraphState, runId: string): { inputTokens: number; outputTokens: number }
```
Sums all `usage` events for a given runId.

```ts
function getToolCallCount(state: GraphState, runId: string): number
```
Counts `tool_call` events for a given runId.

Both exported from the client barrel.

## 3. Children Container Redesign

### State

`ToolCallBlock` tracks one piece of local state:
- `userExpanded: boolean` (default `false`) — whether the user has manually expanded

Derived state:
- `childrenStreaming = blockChildren.some(childId => activeStreams.has(childId))`
- `hasRelays = blockChildren.some(childId => pendingRelays.some(r => r.runId === childId))`

### Visual states

| childrenStreaming | userExpanded | Render |
|-------------------|--------------|--------|
| true | false | **Mini view**: `max-h-[100px] overflow-y-auto`, auto-scroll-to-bottom. "Expand" button. |
| true | true | **Full view**: no height constraint. "Collapse" button. |
| false | false | **Summary row**: single line with tool call count + token usage. Clickable to expand. |
| false | true | **Full view**: no height constraint. "Collapse" button. |

### Mini view auto-scroll

Use a `ref` on the container div and scroll to bottom on content changes:
```tsx
const containerRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!userExpanded && childrenStreaming) {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }
}, [blocks, childrenStreaming, userExpanded]);
```

### Summary row

When `!childrenStreaming && !userExpanded`:
```tsx
<button onClick={() => setUserExpanded(true)} className="...">
  {totalToolCalls} tool calls | {totalTokens} tokens
</button>
```

Where `totalToolCalls` and `totalTokens` are aggregated across all child runIds using the new selectors.

### Expand/collapse toggle

- Mini view: small "Expand" button overlaid at bottom-right of the 100px container
- Full view: "Collapse" button in the header area
- Summary: entire row is clickable

## Files Changed

| File | Change |
|------|--------|
| `packages/ai/types.ts` | Add `usage` to `HarnessEvent` |
| `packages/ai/client/server-event.ts` | Add `usage` to `ServerEvent` |
| `packages/ai/harness/providers/zen.ts` | Emit `usage` event after streaming |
| `packages/ai/harness/agent.ts` | Pass through `usage` events |
| `packages/ai/client/selectors.ts` | Add `getUsage`, `getToolCallCount` |
| `packages/ai/client/index.ts` | Export new selectors |
| `clients/web/src/components/MessageNode.tsx` | Redesign children container in `ToolCallBlock` |

## Testing

- Unit tests for `getUsage` and `getToolCallCount` selectors
- Unit test for `usage` event passthrough in agent harness
- Integration test: `usage` events flow through full pipeline
- Manual test: container behavior during streaming and after completion

## Non-goals

- Token tracking for all providers (start with zen, add others later)
- Relay architecture changes (current composable design is correct)
- Changes to ConversationThread, App, PermissionPrompt, or conversation reducer structure
