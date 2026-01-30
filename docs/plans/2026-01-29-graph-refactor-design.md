# Conversation Graph Refactor

## Problem

The current data model conflates three concerns into one structure:

1. **Event accumulation** — `GraphNode` stores `events: ServerEvent[]` as its source of truth
2. **Graph topology** — `parentId` creates parent-child relationships, but there are no explicit edges and `getChildren()` does a full map scan
3. **UI derivation** — selectors like `getContentBlocks()` re-scan the full event array on every call, and `MessageNode` does dual traversal (children by `runId` + children by `tool_call` block ID)

The result is something that looks like a graph but isn't one. There's no adjacency list, no explicit edges, and the rendering logic embeds assumptions about which node types can branch.

## Design

Three cleanly separated layers:

```
SSE stream → [Graph Builder] → Graph → [View Projector] → ViewNode[] → [React] → DOM
```

Each layer has a single input type and a single output type. No layer reaches into another's data.

### Layer 1: Graph Builder

**Input:** `ServerEvent` (from SSE stream)
**Output:** `Graph`

Pure reducer. Each event creates or updates a node, adds directed edges based on event ordering and `parentId` relationships.

```typescript
interface Graph {
  nodes: Map<string, Node>
  edges: Map<string, string[]>  // adjacency list: sourceId → targetIds
}
```

#### Node

Discriminated union. Each node is one content block — not one "message" or one "run."

```typescript
type Node = { id: string; runId: string } & (
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; output: unknown }
  | { kind: "user"; content: string }
  | { kind: "harness_start"; agentId: string }
  | { kind: "harness_end"; agentId: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
)
```

#### Edges

Directed. No types, no metadata. Just `sourceId → targetId`.

The meaning of an edge is always derivable from the nodes it connects. There is no distinction between "tool_call → tool_result" and "text → tool_call" — both are simply directed edges. Semantics are emergent from node kinds and `runId` attributes.

#### Reducer

```typescript
function reduceEvent(graph: Graph, event: ServerEvent): Graph
```

- Creates a node for the event
- Adds an edge from the previous node in the same `runId` (sequential ordering)
- If the event has a `parentId`, adds an edge from that parent node to this node (cross-run spawn)

### Layer 2: View Projector

**Input:** `Graph`
**Output:** `ViewNode[]` (flat list — the main conversation thread)

Pure function (memoizable). Walks the graph and produces a tree shaped for rendering.

```typescript
interface ViewNode {
  id: string
  runId: string
  role: "user" | "assistant"
  content: ViewContent
  status: "streaming" | "complete" | "error"
  branches: ViewNode[][]  // nested sub-threads
}

type ViewContent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; input: unknown; output?: unknown }
  | { kind: "user"; text: string }
```

#### Traversal rule

When a node has outgoing edges, the View Projector classifies each target:

- **Same `runId`** → continuation. Append to the current flat list.
- **Different `runId`** → branch. Add to `branches` on the current `ViewNode`.

This is the only heuristic. No special-casing by node kind. Any node can have multiple outgoing edges and therefore multiple branches.

#### Merging

The View Projector merges consecutive text/reasoning nodes within the same `runId` into a single `ViewNode` with concatenated content. It also attaches `tool_result` output to the preceding `tool_call` `ViewNode` (matched by shared ID).

### Layer 3: React Components

**Input:** `ViewNode[]`
**Output:** JSX

Dumb rendering. No graph access, no selectors, no event scanning. Components receive pre-built data and render it.

```tsx
function Thread({ nodes }: { nodes: ViewNode[] }) {
  return (
    <>
      {nodes.map(node => (
        <div key={node.id}>
          <Content content={node.content} />
          {node.branches.map((branch, i) => (
            <div key={i} className="border-l pl-4">
              <Thread nodes={branch} />
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
```

Every node can branch. The component doesn't know why — it just renders flat lists with optional nested sub-threads. The branching logic (tool call with subagent, conversation fork, parallel subagents) is decided entirely by the View Projector.

## Examples

### Simple chat

**Graph:**
```
n1 {runId:"r1", kind:"user",  content:"Hello"}
n2 {runId:"r2", kind:"text",  content:"Hi there!"}
n3 {runId:"r3", kind:"user",  content:"What's 2+2?"}
n4 {runId:"r4", kind:"text",  content:"4"}

Edges: n1→n2, n2→n3, n3→n4
```

**ViewNode[] output:** flat list of four nodes, no branches.

### Tool call with subagent

**Graph:**
```
n1 {runId:"r1", kind:"user",        content:"Find auth files"}
n2 {runId:"r2", kind:"text",        content:"Let me search."}
n3 {runId:"r2", kind:"tool_call",   name:"search", input:"auth"}
n4 {runId:"r3", kind:"harness_start", agentId:"searcher"}
n5 {runId:"r3", kind:"text",        content:"Searching..."}
n6 {runId:"r3", kind:"harness_end", agentId:"searcher"}
n7 {runId:"r2", kind:"tool_result", name:"search", output:["auth.ts"]}
n8 {runId:"r2", kind:"text",        content:"Found auth.ts"}

Edges: n1→n2, n2→n3, n3→n4, n3→n7, n4→n5, n5→n6, n7→n8
```

**View Projector walks n3's outgoing edges:**
- `n3→n7`: same runId ("r2") → continuation (flat)
- `n3→n4`: different runId ("r3") → branch

**ViewNode[] output:**
```
[user: "Find auth files"]       ← flat
[text: "Let me search."]       ← flat
[tool_call: "search"]          ← flat, branches: [[text: "Searching..."]]
[tool_result: ["auth.ts"]]     ← flat (continuation)
[text: "Found auth.ts"]        ← flat
```

### Parallel subagents

**Graph:**
```
n3 {runId:"r2", kind:"tool_call", name:"search"}

Edges from n3:
  n3 → n4a  (harness_start, runId:"r3a")  — subagent A
  n3 → n4b  (harness_start, runId:"r3b")  — subagent B
  n3 → n7   (tool_result,   runId:"r2")   — continuation
```

n3 has three outgoing edges. Two different `runId`s → two branches. One same `runId` → continuation. Both subagents render as sibling nested threads.

### Conversation branching

**Graph:**
```
n1 {runId:"r1", kind:"user",  content:"Tell me about X"}
n2 {runId:"r2", kind:"text",  content:"X is..."}
n3 {runId:"r3", kind:"user",  content:"More about Y"}
n4 {runId:"r4", kind:"user",  content:"Actually, about Z"}

Edges: n1→n2, n2→n3, n2→n4
```

n2 has two outgoing edges, both to different `runId`s → two branches. UI can show a branch selector.

## What gets deleted

- `selectors.ts` — all selectors (`getRoots`, `getChildren`, `getText`, `getContentBlocks`, `getStatus`, `getUsage`, `getToolCallCount`) replaced by the View Projector
- `GraphNode.events: ServerEvent[]` — nodes no longer store raw events
- Dual traversal in `MessageNode` (children by `runId` + children by `tool_call` block ID)
- `ContentBlock` type — replaced by `ViewContent`

## What stays

- `reduceEvent` pattern (pure reducer, immutable updates)
- Event-sourced architecture (SSE stream as source of truth)
- `ConversationState` wrapper for session/permissions/streams (Layer 2+ concern)
