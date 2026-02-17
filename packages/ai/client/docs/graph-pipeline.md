# Graph Pipeline

How events flow through the client pipeline: from raw ServerEvents to the conversation hypergraph, then to projected views for rendering, API calls, and graph visualization.

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
- `tool_progress` — streaming progress from tool execution

## 2. Hypergraph Reduction

Events are folded through `reduceEvent()` into a `ConversationGraph` — a three-tier node hierarchy (chunk → block → message) connected by typed hyperedges. `reduceConversation()` wraps this with session state and recomputes the active set after each event.

See `../hypergraph/docs/reduction.md` for ReducerState internals, reduction steps, and block key derivation.

## 3. Active Set

The active set determines which messages are "visible." `defaultActive()` excludes messages replaced by summaries. Operations like `expand`, `collapse`, `summarize`, `branch`, `append`, and `toggle` mutate the active set. `walk()` yields active nodes in sequence order.

## 4. Projections

Three projections transform the graph into consumer-specific formats:

- **Thread** — `projectThread(graph) → ViewNode[]` for chat UI rendering
- **Messages** — `projectMessages(graph) → Message[]` for LLM API follow-up requests
- **DAG** — `projectDAG(graph) → DAGLayout` for SVG graph visualization

See `../hypergraph/projections/docs/rendering.md` for ViewNode shape, key behaviors, and data formats.

## 5. Usage Example

```typescript
import { createSSETransport } from "./transports/sse";
import { reduceConversation, createInitialConversation } from "./hypergraph";
import { projectThread } from "./hypergraph";
import { projectDAG } from "./hypergraph";

let state = createInitialConversation();
const transport = createSSETransport({ baseUrl: "" });

for await (const event of transport.stream(request, signal)) {
  state = reduceConversation(state, event);

  // Chat view
  const viewNodes = projectThread(state.graph);

  // Graph view
  const dagLayout = projectDAG(state.graph);
}
```

The client maintains immutable state by folding events through the reducers, then projects that state into different formats for rendering or API calls.
