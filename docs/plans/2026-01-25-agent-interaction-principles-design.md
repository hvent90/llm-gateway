# Agent Interaction Principles Design

A foundation for building accessible, graph-native agent interaction interfaces.

## Vision

Agent interactions naturally form a **directed acyclic graph (DAG)** of events. Traditional chat UIs flatten this into a linear transcript, hiding the true structure. This design embraces the graph as the primary model, enabling:

- **Branching**: Spawn multiple continuations from any point
- **Pruning**: Disconnect nodes to remove paths
- **Compaction**: Collapse subgraphs into summary nodes
- **Subagent transparency**: Interact with any agent in the tree, not just the root
- **Replay**: Jump to any point and continue from there

The core principle: **Expose everything, let the UI limit.** The interaction model is maximally expressive; interfaces choose what to surface.

---

## Core Data Model

### Events Are Atoms

The smallest unit is an **event**. Every event has:

```typescript
type BaseEvent = {
  type: string;       // Event kind: "text", "reasoning", "tool_call", etc.
  id: string;         // Unique identifier for this logical unit
  runId: string;      // The agent run that produced this event
  parentId?: string;  // Links to parent event (usually a tool_call)
};
```

### Same (type, id) = Same Node

Streaming produces multiple events with the same `type` and `id` — these are **fragments of a single atom**:

```typescript
// These three events are ONE logical node:
{ type: "text", id: "txt-1", content: "Hello" }
{ type: "text", id: "txt-1", content: " world" }
{ type: "text", id: "txt-1", content: "!" }
```

The graph node is the `(type, id)` tuple, not the individual event. Clients coalesce fragments deterministically.

### The DAG Emerges from parentId

Events link to their parent via `parentId`. The graph structure is implicit:

```
user message
    │
    ▼
text (id: a1)
    │
    ▼
tool_call: spawn_agent (id: t1)
    │
    ├──▶ text (parentId: t1, id: s1)       ─┐
    ├──▶ tool_call (parentId: t1, id: s2)   │  subagent events
    ├──▶ tool_result (parentId: t1, id: s3) │  form a subtree
    └──▶ text (parentId: t1, id: s4)       ─┘
    │
    ▼
tool_result (id: t1-result)
    │
    ▼
text (id: a2)
```

Subagents are invoked via tool calls. Their events carry the tool_call's ID as `parentId`, creating the subtree. No special "subagent" type needed.

### Tool Calls Are Joints

Tool calls create structure in the graph. They're where:
- Subagents spawn (subtrees form)
- Human decisions happen (relays occur)
- State changes (side effects execute)
- Branches diverge (multiple continuations possible)

---

## The Relay Pattern

### Generalized Human-in-the-Loop

A **relay** is a moment where the agent passes control to the human, waits for input, then continues. The metaphor: a relay race where the baton passes back and forth.

```typescript
type RelayEvent = {
  type: "relay";
  id: string;
  runId: string;
  parentId?: string;
  kind: RelayKind;
  payload: RelayPayload;
  respond: (response: RelayResponse) => void;
};
```

### Permission as a Relay

Tool permissions are the first relay kind:

```typescript
type PermissionRelay = {
  kind: "permission";
  payload: {
    toolCallId: string;
    tool: string;
    params: Record<string, unknown>;
  };
};

type PermissionResponse = {
  approved: boolean;
  reason?: string;
};
```

### The Relay Flow

1. Agent yields a relay event
2. Orchestrator pauses the agent (via multiplexer)
3. Orchestrator stashes the `respond` callback
4. Client receives relay event (without callback)
5. Human interacts (approves, edits, chooses)
6. Client sends response via API
7. Orchestrator calls stashed `respond()`, resumes agent
8. Agent continues with the response

### Future Relay Kinds

The pattern extends naturally. Future kinds might include:

| Kind | Human Action |
|------|--------------|
| `permission` | Approve/deny tool execution |
| `branch` | Choose which continuation(s) to pursue |
| `edit` | Modify content before agent continues |
| `input` | Provide information the agent needs |
| `confirm` | Approve a plan before execution |

These are not implemented yet — we add them as needed.

---

## Core Principles

### 1. Events are atoms, graphs are molecules

The smallest unit is an event. Graphs emerge from `parentId` relationships. Never design around "messages" or "turns" — those are projections of the underlying graph.

### 2. Same (type, id) = same node

Streaming chunks with matching type and id are fragments of one logical atom. The client coalesces; the data model doesn't.

### 3. Every node is a potential branch point

Any `id` can become a `parentId` for new events. Branching isn't special — it's "emit new events with this parentId."

### 4. Tool calls are the natural joints

They create structure: subagent subtrees, decision points, state changes. The graph articulates at tool calls.

### 5. Relays generalize human-in-the-loop

Permissions, branching, editing, injection are all relay kinds. One pattern, many applications.

### 6. Selection operates on event ID sets

All bulk operations (prune, compact, branch) take `Set<eventId>` as input.

### 7. Compaction creates synthetic summary events

Collapsing nodes preserves semantics. A new summary event carries the semantic weight; original events become provenance.

### 8. Expose everything, UI limits

The model is maximally expressive. Interfaces choose what to surface based on context and user preference.

---

## Event Types

### Current Events

```typescript
type HarnessEvent =
  | { type: "text"; id: string; runId: string; parentId?: string; content: string }
  | { type: "reasoning"; id: string; runId: string; parentId?: string; content: string }
  | { type: "tool_call"; id: string; runId: string; parentId?: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; runId: string; parentId?: string; name: string; output: unknown; status?: "success" | "denied" | "error" }
  | { type: "relay"; id: string; runId: string; parentId?: string; kind: RelayKind; payload: unknown; respond: Function }
  | { type: "error"; runId: string; parentId?: string; error: Error }
```

### Serialized Events (Client-Facing)

The `respond` callback is stripped before sending to clients:

```typescript
type ServerEvent =
  | { type: "connected"; sessionId: string }
  | { type: "text"; id: string; runId: string; parentId?: string; content: string }
  | { type: "reasoning"; id: string; runId: string; parentId?: string; content: string }
  | { type: "tool_call"; id: string; runId: string; parentId?: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; runId: string; parentId?: string; name: string; output: unknown }
  | { type: "relay"; id: string; runId: string; parentId?: string; kind: RelayKind; payload: unknown }
  | { type: "error"; runId: string; parentId?: string; message: string }
```

---

## Graph Operations (Future)

### Branching

Create multiple continuations from a node:

```typescript
interface BranchRequest {
  fromEventId: string;      // Branch point
  count: number;            // How many branches
  params?: {
    temperature?: number;   // Vary sampling
    systemPrompt?: string;  // Vary instructions
  };
}
```

Each branch creates a new `runId` with events whose `parentId` links to the branch point.

### Selection

Select nodes for bulk operations:

```typescript
interface Selection {
  eventIds: Set<string>;
}
```

### Compaction

Collapse selected nodes into a summary:

```typescript
interface CompactRequest {
  selection: Selection;
  mode: "summarize" | "elide";  // LLM summary vs. just hide
}

// Result: a synthetic "summary" event
{ type: "summary"; id: string; parentId: string; content: string; compacted: string[] }
```

Original events are retained as provenance, linked via `compacted` array.

### Pruning

Disconnect nodes from the graph:

```typescript
interface PruneRequest {
  selection: Selection;
  mode: "archive" | "delete";
}
```

---

## What Exists Today

| Component | Status | Location |
|-----------|--------|----------|
| Event types with id/parentId | Implemented | `packages/ai/types.ts` |
| Text/reasoning chunk correlation | Implemented | Same id across chunks |
| DAG reconstruction in client | Implemented | `clients/web/src/state/conversation.ts` |
| Subagent parent linking | Implemented | `context.parentId` in harness |
| Permission pause/resume | Implemented | `orchestrator.ts`, `multiplexer.ts` |
| Deferred promise pattern | Implemented | `primitives/deferred.ts` |
| Persistent event store | Not implemented | — |
| Branching API | Not implemented | — |
| Selection protocol | Not implemented | — |
| Compaction | Not implemented | — |
| Relay (generalized) | Not implemented | Currently `permission_required` |

---

## Migration Path

### Phase 1: Relay Pattern

Refactor `permission_required` to `relay` with `kind: "permission"`:

1. Update `HarnessEvent` type to include `relay`
2. Update harness to yield `relay` events
3. Update orchestrator to handle `relay` events
4. Update clients to handle `relay` events
5. Deprecate `permission_required`

### Phase 2: Persistent Event Store

Enable replay and branching by persisting events:

1. Define event storage schema
2. Implement append-only event log
3. Add sequence numbers for ordering
4. Implement replay from event log

### Phase 3: Graph Operations

Build on persistent store:

1. Branching API
2. Selection protocol
3. Compaction with summary events
4. Pruning with archive mode

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Events over messages | Finer granularity enables precise graph operations |
| Implicit DAG via parentId | No separate graph structure to maintain; emerges from data |
| Relay as generalized HITL | One pattern for all human intervention; extensible via `kind` |
| Coalescing in client | Keep server simple; clients can optimize rendering |
| Expose everything | Maximum flexibility; UI can always hide but can't invent |

---

## Open Questions

1. **Event persistence format**: Append-only log? SQLite? Event store?
2. **Branching UX**: How does "drag to create 5 branches" translate to API calls?
3. **Compaction provenance**: How much original detail to retain?
4. **Cross-session replay**: Can you replay a conversation in a new session?
5. **Conflict resolution**: What if two branches are both "continued"?

---

## References

- Current event types: `packages/ai/types.ts`
- Orchestrator pause/resume: `packages/ai/orchestrator.ts`
- Multiplexer: `packages/ai/multiplexer.ts`
- Client state reconstruction: `clients/web/src/state/conversation.ts`
- Permission design: `docs/plans/2026-01-23-tool-permissions-design.md`
