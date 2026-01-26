# Event Graph Data Model

## Problem

Two issues with the current architecture:

1. **Duplicated client logic** - Both web and CLI clients implement their own stream parsing and conversation state management. This should be a shared library.

2. **Unclear runId ownership** - The current code passes `context.runId` from parent to child harness, implying the parent assigns the child's identity. This conflates identity with lineage.

## New Model

### Principle: Self-Sovereign Identity

Every harness assigns its own `runId`. A parent never tells a child what its ID is.

The only thing passed down is `parentId` - "here's who I am, so you know your parent."

```typescript
// Agent harness
const myRunId = uuidv7();  // I create my own ID

while (iterations++ < maxIterations) {
  for await (const event of providerHarness.invoke({
    context: { parentId: myRunId }  // Child learns who invoked it
  })) {
```

```typescript
// Provider harness
const myRunId = uuidv7();  // I create my own ID
const parentId = params.context?.parentId;  // I receive who invoked me

emit({ type: "text", runId: myRunId, parentId, content: "..." });
```

### Event Structure

Every event has:
- `runId` - "who am I" (the harness that emitted this event)
- `parentId?` - "who invoked me" (optional - root has no parent)

### Emergent Graph Structure

The graph emerges naturally from harness nesting:

```
agentRunId (agent invocation, no parent)
├── turnRunId1 (first provider call, parentId=agentRunId)
│   ├── text: "Let me check that"
│   ├── tool_call (id=tc1)
│   └── tool_result (id=tc1)
├── turnRunId2 (second provider call, parentId=agentRunId)
│   └── text: "Here's what I found..."
```

With subagents spawned from tools:

```
agentRunId
├── turnRunId1 (parentId=agentRunId)
│   ├── tool_call (id=tc1)
│   │   └── subagentRunId (parentId=tc1)
│   │       ├── subTurnRunId1 (parentId=subagentRunId)
│   │       └── subTurnRunId2 (parentId=subagentRunId)
│   └── tool_result (id=tc1)
```

Visualized as a node graph (like shader graphs or Unreal blueprints):
- Each harness invocation is a node
- Each node contains the events it emitted
- Edges flow from parent to child via parentId

## Type Changes

Remove `runId` from context - harnesses are sovereign over their own identity:

```typescript
// Before
export interface InvokeParams {
  context?: {
    runId?: string;    // DELETE
    parentId?: string;
  };
}

// After
export interface InvokeParams {
  context?: {
    parentId?: string;
  };
}
```

Same change for `GeneratorInvokeParams`.

## Client Library

A shared library in `packages/ai/client` that builds a directed graph from events.

### Separation of Concerns

```
SSE bytes → [sse-helper] → HarnessEvent → [client lib] → Graph
```

- **SSE helper** (separate small lib) - transport layer, converts SSE stream to HarnessEvent
- **Client lib** - transport-agnostic, pure graph logic

### API: Pure Reducer

```typescript
function reduceEvent(state: GraphState, event: HarnessEvent): GraphState
```

Framework-agnostic. Clients bring their own state management (React useState, Solid signals, etc.).

### State: Minimal, Events as Source of Truth

```typescript
interface GraphNode {
  runId: string
  parentId?: string
  events: HarnessEvent[]
}

interface GraphState {
  nodes: Map<string, GraphNode>
}
```

No derived fields stored. This enables:
- Replayability (replay events to reconstruct any state)
- Modification (insert/remove events, re-reduce)
- Time travel debugging

### Selectors: Compute on Demand

```typescript
function getRoots(state: GraphState): string[]
function getChildren(state: GraphState, runId: string): string[]
function getText(state: GraphState, runId: string): string
function getToolCalls(state: GraphState, runId: string): ToolCall[]
function getStatus(state: GraphState, runId: string): 'streaming' | 'complete' | 'error'
```

Selectors derive views from the event history. Clients can memoize if needed.

### Layered Architecture

```
packages/ai/client/
├── graph.ts         # Core: HarnessEvent → Graph (pure, single responsibility)
├── selectors.ts     # Computed views over graph state
└── conversation.ts  # Optional: composes graph with user messages for chat UIs
```

**Core graph library** - only handles `HarnessEvent`. Clean abstraction, reusable for any consumer (chat UIs, batch processing, debugging tools, logging).

**Conversation layer** - imports graph module, adds user message handling. Chat applications use this; non-chat consumers use core directly.

```typescript
// conversation.ts
interface ConversationState {
  graph: GraphState                    // harness event graph
  userMessages: UserMessage[]          // application-level
  pending: string | null               // user input awaiting response
}

type ConversationEvent =
  | { type: 'user'; content: string }
  | HarnessEvent

function reduceConversation(
  state: ConversationState,
  event: ConversationEvent
): ConversationState
```

This keeps the core pure while providing convenience for the common chat use case.
