# Graph Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current event-accumulating GraphNode model with a true directed graph (typed nodes + untyped edges) and a thread projection layer, deleting all old selectors and components.

**Architecture:** Three layers — Graph Builder (events → graph), Thread Projection (graph → view model), React/Solid Components (view model → DOM). No backwards compatibility. Clean break.

**Tech Stack:** TypeScript, Bun test runner

**Design doc:** `docs/plans/2026-01-29-graph-refactor-design.md`

---

### Task 1: New Graph Types

**Files:**
- Rewrite: `packages/ai/client/types.ts`

**Step 1: Write the new types**

Replace the entire contents of `types.ts` with:

```typescript
import type { ServerEvent } from "./server-event";

/**
 * A node in the event graph. Discriminated union — one node per content block.
 */
export type Node = { id: string; runId: string } & (
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; eventId: string; name: string; input: unknown }
  | { kind: "tool_result"; eventId: string; name: string; output: unknown }
  | { kind: "user"; content: string }
  | { kind: "harness_start"; agentId: string }
  | { kind: "harness_end"; agentId: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "relay"; relayId: string; toolCallId: string; tool: string; params: Record<string, unknown> }
);

/**
 * Directed graph — typed nodes, untyped edges.
 */
export interface Graph {
  nodes: Map<string, Node>;
  edges: Map<string, string[]>; // adjacency list: sourceId → [targetId, ...]
}

/**
 * Internal reducer state. Extends Graph with bookkeeping for building edges.
 */
export interface GraphBuilderState extends Graph {
  nextId: number; // monotonic counter for generated node IDs
  lastNodeByRun: Map<string, string>; // runId → most recent nodeId in that run
}
```

Notes:
- `eventId` on `tool_call` / `tool_result` preserves the original event `id` for pairing in the projection layer.
- `GraphBuilderState` extends `Graph` so it can be passed anywhere a `Graph` is expected.
- `relay` is a node kind because relay events need to be represented in the graph.

**Step 2: Verify types compile**

Run: `bunx tsc --noEmit packages/ai/client/types.ts`

This will produce errors because other files still import the old types. That's expected — we'll fix them in subsequent tasks.

**Step 3: Commit**

```bash
git add packages/ai/client/types.ts
git commit -m "refactor: replace GraphNode/GraphState with Node/Graph/GraphBuilderState"
```

---

### Task 2: New Graph Reducer

**Files:**
- Rewrite: `packages/ai/client/graph.ts`
- Rewrite: `packages/ai/client/__tests__/selectors.test.ts` → rename to `__tests__/graph.test.ts`

**Step 1: Write failing tests for the new reducer**

Create `packages/ai/client/__tests__/graph.test.ts` (delete or overwrite the old `selectors.test.ts`):

```typescript
import { describe, test, expect } from "bun:test";
import { createInitialGraph, reduceGraphEvent } from "../graph";
import type { Node } from "../types";

describe("Graph Reducer", () => {
  test("creates a node for a text event", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello",
    });
    expect(g.nodes.size).toBe(1);
    const node = [...g.nodes.values()][0]!;
    expect(node.kind).toBe("text");
    expect(node.runId).toBe("r1");
    if (node.kind === "text") expect(node.content).toBe("Hello");
  });

  test("creates sequential edges within the same runId", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text", id: "t1", runId: "r1", agentId: "a1", content: "A",
    });
    g = reduceGraphEvent(g, {
      type: "text", id: "t2", runId: "r1", agentId: "a1", content: "B",
    });
    // t1 → t2
    expect(g.edges.get("t1")).toEqual(["t2"]);
  });

  test("does not create edges between different runIds (without parentId)", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text", id: "t1", runId: "r1", agentId: "a1", content: "A",
    });
    g = reduceGraphEvent(g, {
      type: "text", id: "t2", runId: "r2", agentId: "a2", content: "B",
    });
    expect(g.edges.get("t1") ?? []).toEqual([]);
  });

  test("creates cross-run edge via parentId", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1",
      name: "search", input: "auth",
    });
    g = reduceGraphEvent(g, {
      type: "harness_start", runId: "r2", agentId: "sub",
      parentId: "tc-1",
    });
    // tc-1 → r2:start (cross-run spawn edge)
    const targets = g.edges.get("tc-1") ?? [];
    expect(targets).toContain("r2:start");
  });

  test("tool_call node stores eventId", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1",
      name: "bash", input: { command: "ls" },
    });
    const node = g.nodes.get("tc-1")!;
    expect(node.kind).toBe("tool_call");
    if (node.kind === "tool_call") expect(node.eventId).toBe("tc-1");
  });

  test("tool_result node stores eventId and gets unique node id", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1",
      name: "bash", input: { command: "ls" },
    });
    g = reduceGraphEvent(g, {
      type: "tool_result", id: "tc-1", runId: "r1", agentId: "a1",
      name: "bash", output: "files",
    });
    // tool_result node id should differ from tool_call
    expect(g.nodes.has("tc-1")).toBe(true); // tool_call
    expect(g.nodes.has("tc-1:result")).toBe(true); // tool_result
    const trNode = g.nodes.get("tc-1:result")!;
    if (trNode.kind === "tool_result") expect(trNode.eventId).toBe("tc-1");
  });

  test("harness_start/end get deterministic node ids", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "harness_start", runId: "r1", agentId: "a1",
    });
    g = reduceGraphEvent(g, {
      type: "harness_end", runId: "r1", agentId: "a1",
    });
    expect(g.nodes.has("r1:start")).toBe(true);
    expect(g.nodes.has("r1:end")).toBe(true);
  });

  test("skips connected events", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, { type: "connected", sessionId: "s-1" });
    expect(g.nodes.size).toBe(0);
  });

  test("user events create user nodes", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "user" as any, runId: "u1", content: "Hello",
    });
    const node = g.nodes.get("u1")!;
    expect(node.kind).toBe("user");
    if (node.kind === "user") expect(node.content).toBe("Hello");
  });

  test("subagent scenario: tool_call has edges to both result and spawn", () => {
    let g = createInitialGraph();
    // Parent agent text + tool call
    g = reduceGraphEvent(g, {
      type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Let me search.",
    });
    g = reduceGraphEvent(g, {
      type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1",
      name: "search", input: "auth",
    });
    // Subagent spawned from tool_call
    g = reduceGraphEvent(g, {
      type: "harness_start", runId: "r2", agentId: "sub", parentId: "tc-1",
    });
    g = reduceGraphEvent(g, {
      type: "text", id: "t2", runId: "r2", agentId: "sub", content: "Searching...",
    });
    g = reduceGraphEvent(g, {
      type: "harness_end", runId: "r2", agentId: "sub",
    });
    // Parent continues after subagent
    g = reduceGraphEvent(g, {
      type: "tool_result", id: "tc-1", runId: "r1", agentId: "a1",
      name: "search", output: ["auth.ts"],
    });
    g = reduceGraphEvent(g, {
      type: "text", id: "t3", runId: "r1", agentId: "a1", content: "Found auth.ts",
    });

    // Verify edges
    const tcEdges = g.edges.get("tc-1") ?? [];
    expect(tcEdges).toContain("r2:start"); // spawn edge
    expect(tcEdges).toContain("tc-1:result"); // sequential edge (next in r1)
    expect(g.edges.get("tc-1:result")).toEqual(["t3"]); // sequential
    expect(g.edges.get("r2:start")).toEqual(["t2"]); // sequential in r2
    expect(g.edges.get("t2")).toEqual(["r2:end"]); // sequential in r2
  });

  test("parentId as runId creates edge from last node of that run", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "harness_start", runId: "agent-1", agentId: "a1",
    });
    g = reduceGraphEvent(g, {
      type: "text", id: "t1", runId: "agent-1", agentId: "a1", content: "Thinking",
    });
    // Turn starts with parentId = agent runId
    g = reduceGraphEvent(g, {
      type: "harness_start", runId: "turn-1", agentId: "provider",
      parentId: "agent-1",
    });
    // Edge from t1 (last node in agent-1) to turn-1:start
    const t1Edges = g.edges.get("t1") ?? [];
    expect(t1Edges).toContain("turn-1:start");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: FAIL (functions don't exist yet)

**Step 3: Write the reducer implementation**

Rewrite `packages/ai/client/graph.ts`:

```typescript
import type { ServerEvent } from "./server-event";
import type { Node, Graph, GraphBuilderState } from "./types";

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string;
};

export type GraphEvent = ServerEvent | UserEvent;

export function createInitialGraph(): GraphBuilderState {
  return {
    nodes: new Map(),
    edges: new Map(),
    nextId: 0,
    lastNodeByRun: new Map(),
  };
}

export function reduceGraphEvent(
  state: GraphBuilderState,
  event: GraphEvent,
): GraphBuilderState {
  if (event.type === "connected") return state;

  const node = eventToNode(state, event);
  if (!node) return state;

  const newNodes = new Map(state.nodes);
  newNodes.set(node.id, node);

  const newEdges = new Map(state.edges);
  const newLastByRun = new Map(state.lastNodeByRun);

  const runId = node.runId;

  // Sequential edge: previous node in same run → this node
  const prevInRun = state.lastNodeByRun.get(runId);
  if (prevInRun) {
    const existing = newEdges.get(prevInRun) ?? [];
    newEdges.set(prevInRun, [...existing, node.id]);
  }

  // Cross-run edge: parentId → this node
  const parentId = "parentId" in event ? (event as any).parentId : undefined;
  if (parentId && parentId !== prevInRun) {
    // parentId might be a node ID (tool_call block ID) or a runId
    if (state.nodes.has(parentId)) {
      // Direct node reference (e.g., tool_call block ID)
      const existing = newEdges.get(parentId) ?? [];
      if (!existing.includes(node.id)) {
        newEdges.set(parentId, [...existing, node.id]);
      }
    } else {
      // RunId reference — edge from last node in that run
      const parentLastNode = state.lastNodeByRun.get(parentId);
      if (parentLastNode && parentLastNode !== prevInRun) {
        const existing = newEdges.get(parentLastNode) ?? [];
        if (!existing.includes(node.id)) {
          newEdges.set(parentLastNode, [...existing, node.id]);
        }
      }
    }
  }

  newLastByRun.set(runId, node.id);

  return {
    nodes: newNodes,
    edges: newEdges,
    nextId: state.nextId + 1,
    lastNodeByRun: newLastByRun,
  };
}

function eventToNode(state: GraphBuilderState, event: GraphEvent): Node | null {
  switch (event.type) {
    case "text":
      return { id: event.id, runId: event.runId, kind: "text", content: event.content };
    case "reasoning":
      return { id: event.id, runId: event.runId, kind: "reasoning", content: event.content };
    case "tool_call":
      return {
        id: event.id, runId: event.runId, kind: "tool_call",
        eventId: event.id, name: event.name, input: event.input,
      };
    case "tool_result":
      return {
        id: `${event.id}:result`, runId: event.runId, kind: "tool_result",
        eventId: event.id, name: event.name, output: event.output,
      };
    case "harness_start":
      return { id: `${event.runId}:start`, runId: event.runId, kind: "harness_start", agentId: event.agentId };
    case "harness_end":
      return { id: `${event.runId}:end`, runId: event.runId, kind: "harness_end", agentId: event.agentId };
    case "error":
      return { id: `err-${state.nextId}`, runId: event.runId, kind: "error", message: event.message };
    case "usage":
      return {
        id: `usage-${state.nextId}`, runId: event.runId, kind: "usage",
        inputTokens: event.inputTokens, outputTokens: event.outputTokens,
      };
    case "relay":
      return {
        id: event.id, runId: event.runId, kind: "relay",
        relayId: event.id, toolCallId: event.toolCallId,
        tool: event.tool, params: event.params,
      };
    case "user":
      return { id: event.runId, runId: event.runId, kind: "user", content: event.content };
    default:
      return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/ai/client/graph.ts packages/ai/client/__tests__/graph.test.ts
git rm packages/ai/client/__tests__/selectors.test.ts 2>/dev/null
git commit -m "refactor: rewrite graph reducer — one node per content block, directed edges"
```

---

### Task 3: Thread Projection

**Files:**
- Create: `packages/ai/client/projections/thread.ts`
- Create: `packages/ai/client/__tests__/thread-projection.test.ts`

**Step 1: Write failing tests**

Create `packages/ai/client/__tests__/thread-projection.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { createInitialGraph, reduceGraphEvent } from "../graph";
import { projectThread } from "../projections/thread";
import type { GraphBuilderState } from "../types";
import type { GraphEvent } from "../graph";

/** Helper: reduce a sequence of events into a graph. */
function buildGraph(events: GraphEvent[]): GraphBuilderState {
  let g = createInitialGraph();
  for (const e of events) g = reduceGraphEvent(g, e);
  return g;
}

describe("Thread Projection", () => {
  test("simple chat: flat list, no branches", () => {
    const g = buildGraph([
      { type: "user" as any, runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi there!" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    // User node + harness_start + text + harness_end = nodes in graph
    // Projection should produce flat list with user message and assistant text
    const userNodes = view.filter(n => n.content.kind === "user");
    const textNodes = view.filter(n => n.content.kind === "text");
    expect(userNodes.length).toBe(1);
    expect(textNodes.length).toBeGreaterThanOrEqual(1);
    // All should have empty branches
    for (const n of view) {
      expect(n.branches).toEqual([]);
    }
  });

  test("merges consecutive text nodes into one ViewNode", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "world" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const textNodes = view.filter(n => n.content.kind === "text");
    expect(textNodes.length).toBe(1);
    if (textNodes[0]!.content.kind === "text") {
      expect(textNodes[0]!.content.text).toBe("Hello world");
    }
  });

  test("merges consecutive reasoning nodes", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "reasoning", id: "r1a", runId: "r1", agentId: "a1", content: "Thinking" },
      { type: "reasoning", id: "r1b", runId: "r1", agentId: "a1", content: "..." },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const reasoningNodes = view.filter(n => n.content.kind === "reasoning");
    expect(reasoningNodes.length).toBe(1);
    if (reasoningNodes[0]!.content.kind === "reasoning") {
      expect(reasoningNodes[0]!.content.text).toBe("Thinking...");
    }
  });

  test("pairs tool_call with tool_result", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_result", id: "tc-1", runId: "r1", agentId: "a1", name: "bash", output: "files" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNodes = view.filter(n => n.content.kind === "tool_call");
    expect(tcNodes.length).toBe(1);
    if (tcNodes[0]!.content.kind === "tool_call") {
      expect(tcNodes[0]!.content.name).toBe("bash");
      expect(tcNodes[0]!.content.output).toBe("files");
    }
  });

  test("tool_call without result has no output", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNodes = view.filter(n => n.content.kind === "tool_call");
    if (tcNodes[0]!.content.kind === "tool_call") {
      expect(tcNodes[0]!.content.output).toBeUndefined();
    }
  });

  test("subagent creates a branch on the tool_call node", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Let me search." },
      { type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1", name: "search", input: "auth" },
      // Subagent spawns
      { type: "harness_start", runId: "r2", agentId: "sub", parentId: "tc-1" },
      { type: "text", id: "t2", runId: "r2", agentId: "sub", content: "Searching..." },
      { type: "harness_end", runId: "r2", agentId: "sub" },
      // Parent continues
      { type: "tool_result", id: "tc-1", runId: "r1", agentId: "a1", name: "search", output: ["auth.ts"] },
      { type: "text", id: "t3", runId: "r1", agentId: "a1", content: "Found it." },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);

    // Find the tool_call ViewNode
    const tcNode = view.find(n => n.content.kind === "tool_call");
    expect(tcNode).toBeDefined();
    expect(tcNode!.branches.length).toBe(1); // one subagent branch

    // The branch should contain the subagent's text
    const branch = tcNode!.branches[0]!;
    const subText = branch.find(n => n.content.kind === "text");
    expect(subText).toBeDefined();
    if (subText!.content.kind === "text") {
      expect(subText!.content.text).toBe("Searching...");
    }

    // tool_result and final text should be in the flat list (continuation)
    const resultNode = view.find(n => n.content.kind === "tool_call" && n.content.output != null);
    expect(resultNode).toBeDefined();
    const finalText = view.find(n => n.content.kind === "text" && n.content.text === "Found it.");
    expect(finalText).toBeDefined();
  });

  test("parallel subagents create multiple branches", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1", name: "search", input: "x" },
      // Two subagents from same tool_call
      { type: "harness_start", runId: "r2a", agentId: "sub-a", parentId: "tc-1" },
      { type: "text", id: "t2a", runId: "r2a", agentId: "sub-a", content: "Path A" },
      { type: "harness_end", runId: "r2a", agentId: "sub-a" },
      { type: "harness_start", runId: "r2b", agentId: "sub-b", parentId: "tc-1" },
      { type: "text", id: "t2b", runId: "r2b", agentId: "sub-b", content: "Path B" },
      { type: "harness_end", runId: "r2b", agentId: "sub-b" },
      // Parent continues
      { type: "tool_result", id: "tc-1", runId: "r1", agentId: "a1", name: "search", output: "done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNode = view.find(n => n.content.kind === "tool_call");
    expect(tcNode!.branches.length).toBe(2);
  });

  test("skips harness_start, harness_end, usage, error nodes from visible output", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "usage", runId: "r1", agentId: "a1", inputTokens: 100, outputTokens: 50 },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    // Only the text node should appear (harness_start/end and usage are structural)
    expect(view.length).toBe(1);
    expect(view[0]!.content.kind).toBe("text");
  });

  test("status reflects streaming vs complete", () => {
    const streaming = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
    ]);
    const viewStreaming = projectThread(streaming);
    expect(viewStreaming[0]!.status).toBe("streaming");

    const complete = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const viewComplete = projectThread(complete);
    expect(viewComplete[0]!.status).toBe("complete");
  });

  test("empty graph produces empty view", () => {
    const g = createInitialGraph();
    const view = projectThread(g);
    expect(view).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/__tests__/thread-projection.test.ts`
Expected: FAIL (module not found)

**Step 3: Write the thread projection**

Create `packages/ai/client/projections/thread.ts`:

```typescript
import type { Graph, Node } from "../types";

export interface ViewNode {
  id: string;
  runId: string;
  role: "user" | "assistant";
  content: ViewContent;
  status: "streaming" | "complete" | "error";
  branches: ViewNode[][];
}

export type ViewContent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown; output?: unknown }
  | { kind: "user"; text: string };

/**
 * Project a Graph into a flat ViewNode list for thread-style rendering.
 *
 * Rules:
 * - Same runId edge targets → continuation (appended to flat list)
 * - Different runId edge targets → branch (nested under current node)
 * - Consecutive text/reasoning nodes are merged
 * - tool_result is folded into the preceding tool_call's output
 * - harness_start, harness_end, usage nodes are structural (not rendered)
 */
export function projectThread(graph: Graph): ViewNode[] {
  // Find root nodes (nodes with no incoming edges)
  const hasIncoming = new Set<string>();
  for (const targets of graph.edges.values()) {
    for (const t of targets) hasIncoming.add(t);
  }
  const roots: string[] = [];
  for (const id of graph.nodes.keys()) {
    if (!hasIncoming.has(id)) roots.push(id);
  }

  if (roots.length === 0) return [];

  // Walk from roots, producing a flat list
  // We need to find the "main thread" entry point.
  // Sort roots by insertion order (Map preserves insertion order).
  return walkThread(graph, roots);
}

function walkThread(graph: Graph, startIds: string[]): ViewNode[] {
  const result: ViewNode[] = [];
  const visited = new Set<string>();

  // Queue of node IDs to process as part of the flat thread
  const queue: string[] = [...startIds];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (!node) continue;

    const targets = graph.edges.get(nodeId) ?? [];

    // Classify targets: same runId = continuation, different = branch
    const continuations: string[] = [];
    const branchStarts: string[] = [];
    for (const targetId of targets) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) continue;
      if (targetNode.runId === node.runId) {
        continuations.push(targetId);
      } else {
        branchStarts.push(targetId);
      }
    }

    // Build branches (each branch starts a new sub-thread)
    const branches: ViewNode[][] = [];
    for (const branchStart of branchStarts) {
      if (!visited.has(branchStart)) {
        const subRoots = [branchStart];
        const branch = walkThread(graph, subRoots);
        if (branch.length > 0) branches.push(branch);
      }
    }

    // Convert node to ViewNode (if it's a renderable kind)
    const viewNode = nodeToViewNode(graph, node, branches);
    if (viewNode) {
      // Try to merge with previous node
      const prev = result[result.length - 1];
      const merged = tryMerge(prev, viewNode);
      if (merged) {
        result[result.length - 1] = merged;
      } else {
        result.push(viewNode);
      }
    } else if (branches.length > 0) {
      // Structural node with branches — attach branches to previous renderable node
      const prev = result[result.length - 1];
      if (prev) {
        result[result.length - 1] = {
          ...prev,
          branches: [...prev.branches, ...branches],
        };
      }
    }

    // Queue continuations
    for (const c of continuations) {
      if (!visited.has(c)) queue.push(c);
    }
  }

  return result;
}

/** Renderable node kinds — everything else is structural. */
const RENDERABLE_KINDS = new Set(["text", "reasoning", "tool_call", "user"]);

function nodeToViewNode(graph: Graph, node: Node, branches: ViewNode[][]): ViewNode | null {
  // tool_result is folded into tool_call, not rendered separately
  if (node.kind === "tool_result") {
    // Find the tool_call ViewNode we already emitted and attach output
    // This is handled by the caller via the merge/fold step
    return null;
  }

  if (!RENDERABLE_KINDS.has(node.kind)) return null;

  const content = nodeToContent(graph, node);
  if (!content) return null;

  const status = getRunStatus(graph, node.runId);

  return {
    id: node.id,
    runId: node.runId,
    role: node.kind === "user" ? "user" : "assistant",
    content,
    status,
    branches,
  };
}

function nodeToContent(graph: Graph, node: Node): ViewContent | null {
  switch (node.kind) {
    case "text":
      return { kind: "text", text: node.content };
    case "reasoning":
      return { kind: "reasoning", text: node.content };
    case "tool_call": {
      // Look for matching tool_result in the graph
      const resultNodeId = `${node.eventId}:result`;
      const resultNode = graph.nodes.get(resultNodeId);
      const output = resultNode?.kind === "tool_result" ? resultNode.output : undefined;
      return { kind: "tool_call", id: node.eventId, name: node.name, input: node.input, output };
    }
    case "user":
      return { kind: "user", text: node.content };
    default:
      return null;
  }
}

/** Try to merge two consecutive ViewNodes (e.g., consecutive text blocks). */
function tryMerge(prev: ViewNode | undefined, next: ViewNode): ViewNode | null {
  if (!prev) return null;
  if (prev.runId !== next.runId) return null;
  if (prev.branches.length > 0) return null;

  // Merge consecutive text
  if (prev.content.kind === "text" && next.content.kind === "text") {
    return {
      ...prev,
      content: { kind: "text", text: prev.content.text + next.content.text },
      branches: next.branches,
    };
  }

  // Merge consecutive reasoning
  if (prev.content.kind === "reasoning" && next.content.kind === "reasoning") {
    return {
      ...prev,
      content: { kind: "reasoning", text: prev.content.text + next.content.text },
      branches: next.branches,
    };
  }

  return null;
}

/** Derive the status of a run from its graph nodes. */
function getRunStatus(graph: Graph, runId: string): "streaming" | "complete" | "error" {
  let hasStart = false;
  let hasEnd = false;
  let hasError = false;

  for (const node of graph.nodes.values()) {
    if (node.runId !== runId) continue;
    if (node.kind === "harness_start") hasStart = true;
    if (node.kind === "harness_end") hasEnd = true;
    if (node.kind === "error") hasError = true;
  }

  if (hasError) return "error";
  if (hasEnd) return "complete";
  if (hasStart) return "streaming";
  return "complete";
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/__tests__/thread-projection.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/ai/client/projections/thread.ts packages/ai/client/__tests__/thread-projection.test.ts
git commit -m "feat: add thread projection — Graph → ViewNode[] for chat UI"
```

---

### Task 4: Update Conversation Layer

**Files:**
- Rewrite: `packages/ai/client/conversation.ts`
- Rewrite: `packages/ai/client/__tests__/conversation.test.ts`

**Step 1: Write failing tests**

Rewrite `packages/ai/client/__tests__/conversation.test.ts`. The conversation layer still manages session, relays, granted tools, active streams, and connection state. It delegates graph building to the new `reduceGraphEvent`. Tests should verify:

- `createInitialConversation()` produces empty state with `GraphBuilderState`
- `connected` event sets sessionId
- `user` event delegates to graph reducer (creates user node)
- `relay` event adds to pendingRelays AND delegates to graph
- `relay_resolved` event removes relay, grants tool if approved
- `stream_start/end` toggle isConnected
- `harness_start/end` track activeStreams AND delegate to graph
- `getAutoApprovableRelays` and `getSameToolRelays` still work

The tests should assert against the new graph structure (nodes with `kind` field) rather than the old one (nodes with `events` array).

Key assertions to update in tests:
- Replace `state.graph.nodes.get(id)!.events[0]!.type` with `state.graph.nodes.has(id + ":start")` or similar
- Replace `getRole(state.graph, id)` / `getContentBlocks(...)` with direct node kind checks
- Replace `getChildren(state.graph, id)` with edge checks

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: FAIL

**Step 3: Rewrite conversation.ts**

Update `ConversationState` to use `GraphBuilderState` instead of `GraphState`:

```typescript
import type { ServerEvent } from "./server-event";
import type { GraphBuilderState } from "./types";
import { createInitialGraph, reduceGraphEvent } from "./graph";
import type { GraphEvent } from "./graph";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: GraphBuilderState;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;
  isConnected: boolean;
}

export type ConversationEvent =
  | ServerEvent
  | { type: "user"; runId: string; parentId?: string; content: string; timestamp?: number }
  | { type: "stream_start" }
  | { type: "stream_end" }
  | { type: "relay_resolved"; relayId: string; tool: string; approved: boolean };

export function createInitialConversation(): ConversationState {
  return {
    graph: createInitialGraph(),
    sessionId: null,
    pendingRelays: [],
    grantedTools: new Set(),
    activeStreams: new Set(),
    isConnected: false,
  };
}

export function getAutoApprovableRelays(state: ConversationState): PendingRelay[] {
  return state.pendingRelays.filter((r) => state.grantedTools.has(r.tool));
}

export function getSameToolRelays(state: ConversationState, tool: string): PendingRelay[] {
  return state.pendingRelays.filter((r) => r.tool === tool);
}

export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case "connected":
      return { ...state, sessionId: event.sessionId };

    case "user":
      return { ...state, graph: reduceGraphEvent(state.graph, event) };

    case "relay": {
      const relay: PendingRelay = {
        relayId: event.id,
        runId: event.runId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
      return {
        ...state,
        pendingRelays: [...state.pendingRelays, relay],
        graph: reduceGraphEvent(state.graph, event),
      };
    }

    case "relay_resolved": {
      const pendingRelays = state.pendingRelays.filter((r) => r.relayId !== event.relayId);
      const grantedTools = event.approved
        ? new Set([...state.grantedTools, event.tool])
        : state.grantedTools;
      return { ...state, pendingRelays, grantedTools };
    }

    case "stream_start":
      return { ...state, isConnected: true };

    case "stream_end":
      return { ...state, isConnected: false, activeStreams: new Set() };

    case "harness_start": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.add(event.runId);
      return { ...state, activeStreams, graph: reduceGraphEvent(state.graph, event) };
    }

    case "harness_end": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.delete(event.runId);
      return { ...state, activeStreams, graph: reduceGraphEvent(state.graph, event) };
    }

    default:
      return { ...state, graph: reduceGraphEvent(state.graph, event as ServerEvent) };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/ai/client/conversation.ts packages/ai/client/__tests__/conversation.test.ts
git commit -m "refactor: update conversation layer to use new graph types"
```

---

### Task 5: Update Package Exports

**Files:**
- Rewrite: `packages/ai/client/index.ts`
- Delete: `packages/ai/client/selectors.ts`

**Step 1: Delete old selectors**

```bash
rm packages/ai/client/selectors.ts
```

**Step 2: Rewrite index.ts**

```typescript
// Core graph
export { createInitialGraph, reduceGraphEvent } from "./graph";
export type { GraphEvent } from "./graph";

// Types
export type { Node, Graph, GraphBuilderState } from "./types";

// Projections
export { projectThread } from "./projections/thread";
export type { ViewNode, ViewContent } from "./projections/thread";

// Conversation layer
export {
  createInitialConversation,
  reduceConversation,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "./conversation";
export type { PendingRelay, ConversationState, ConversationEvent } from "./conversation";

// Server event types
export type { ServerEvent, StreamRequest } from "./server-event";

// Transports
export { createSSETransport } from "./transports/sse";
export { createHTTPTransport } from "./transports/http";
```

**Step 3: Verify compilation**

Run: `bunx tsc --noEmit`
Expected: Errors in client code (web, CLI) that still imports old symbols. That's expected — next tasks fix those.

**Step 4: Commit**

```bash
git add packages/ai/client/index.ts
git rm packages/ai/client/selectors.ts
git commit -m "refactor: delete selectors.ts, update package exports for new graph API"
```

---

### Task 6: Update Web Client

**Files:**
- Rewrite: `clients/web/src/types.ts`
- Rewrite: `clients/web/src/App.tsx`
- Rewrite: `clients/web/src/components/ConversationThread.tsx`
- Rewrite: `clients/web/src/components/MessageNode.tsx`

This task updates the web client to use `projectThread()` and render `ViewNode[]`. The components become dumb renderers that receive pre-built view models.

**Step 1: Update `clients/web/src/types.ts`**

Remove old type re-exports, add new ones:

```typescript
export type { ServerEvent } from "../../../packages/ai/client/server-event";
export type { ConversationState, PendingRelay } from "../../../packages/ai/client";
export type { ViewNode, ViewContent } from "../../../packages/ai/client";
export type { Graph } from "../../../packages/ai/client";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolPermission {
  tool: string;
  params?: Record<string, string>;
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}
```

**Step 2: Rewrite `ConversationThread.tsx`**

The component now receives `ViewNode[]` instead of a graph + runIds. It renders a flat list with recursive branches.

```tsx
import { useRef, useEffect } from "react";
import type { ViewNode, PendingRelay } from "../types";
import { PermissionPrompt } from "./PermissionPrompt";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface ConversationThreadProps {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function ConversationThread({
  nodes,
  pendingRelays,
  permissionHandlers,
  activeStreams,
  scrollContainerRef,
}: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef]);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [nodes, pendingRelays]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Thread
        nodes={nodes}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
        activeStreams={activeStreams}
      />
      <div ref={bottomRef} />
    </div>
  );
}

function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
  activeStreams,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
}) {
  return (
    <>
      {nodes.map((node) => (
        <NodeView
          key={node.id}
          node={node}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
          activeStreams={activeStreams}
        />
      ))}
    </>
  );
}

function NodeView({
  node,
  pendingRelays,
  permissionHandlers,
  activeStreams,
}: {
  node: ViewNode;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
}) {
  const isUser = node.role === "user";
  const isStreaming = activeStreams.has(node.runId);
  const nodeRelays = pendingRelays.filter((r) => r.runId === node.runId);

  return (
    <div className="mb-4">
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${node.runId.slice(0, 8)}`}
        {isStreaming && (
          <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
        )}
      </div>
      <Content content={node.content} />
      {node.branches.map((branch, i) => (
        <div key={i} className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
          <Thread
            nodes={branch}
            pendingRelays={pendingRelays}
            permissionHandlers={permissionHandlers}
            activeStreams={activeStreams}
          />
        </div>
      ))}
      {nodeRelays.map((relay) => (
        <PermissionPrompt
          key={relay.relayId}
          request={relay}
          onAllow={() => permissionHandlers.onAllow(relay)}
          onAllowAll={() => permissionHandlers.onAllowAll(relay)}
          onDeny={() => permissionHandlers.onDeny(relay)}
        />
      ))}
    </div>
  );
}

function Content({ content }: { content: ViewNode["content"] }) {
  switch (content.kind) {
    case "text":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "reasoning":
      return <div className="mt-1 text-sm italic text-gray-500">{content.text}</div>;
    case "user":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "tool_call": {
      const inputStr =
        typeof content.input === "string" ? content.input : JSON.stringify(content.input, null, 2);
      const outputStr =
        content.output !== undefined
          ? typeof content.output === "string"
            ? content.output
            : JSON.stringify(content.output, null, 2)
          : null;
      return (
        <div className="my-2 rounded border border-gray-700 bg-gray-800 p-2 text-sm">
          <div className="font-mono text-yellow-400">{content.name}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words text-gray-400">{inputStr}</pre>
          {outputStr && (
            <div className="mt-2 border-t border-gray-700 pt-2">
              <span className="text-gray-500">↳ </span>
              <pre className="whitespace-pre-wrap break-words text-gray-300">{outputStr}</pre>
            </div>
          )}
        </div>
      );
    }
  }
}
```

**Step 3: Update `App.tsx`**

Key changes:
- Import `projectThread` instead of selectors
- Call `projectThread(state.graph)` to get `ViewNode[]`
- Pass `ViewNode[]` to `ConversationThread` instead of graph
- Update `buildMessagesFromGraph` to walk the graph directly or use the projection

Replace selector imports:
```typescript
import {
  createSSETransport,
  createHTTPTransport,
  projectThread,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "../../../packages/ai/client";
import { reduceConversation, createInitialConversation } from "../../../packages/ai/client";
```

Replace `buildMessagesFromGraph` — walk the projected view:
```typescript
function buildMessagesFromView(nodes: ViewNode[]): Message[] {
  const messages: Message[] = [];
  for (const node of nodes) {
    if (node.content.kind === "text") {
      messages.push({ role: node.role, content: node.content.text });
    } else if (node.content.kind === "user") {
      messages.push({ role: "user", content: node.content.text });
    }
    // Recurse into branches
    if (node.branches.length > 0) {
      for (const branch of node.branches) {
        messages.push(...buildMessagesFromView(branch));
      }
    }
  }
  return messages;
}
```

In the JSX, compute projection and pass it:
```tsx
const viewNodes = projectThread(state.graph);
// ...
<ConversationThread
  nodes={viewNodes}
  pendingRelays={state.pendingRelays}
  permissionHandlers={permissionHandlers}
  activeStreams={state.activeStreams}
  scrollContainerRef={scrollContainerRef}
/>
```

**Step 4: Delete `MessageNode.tsx`**

All rendering now lives in `ConversationThread.tsx`. Delete the old file:
```bash
rm clients/web/src/components/MessageNode.tsx
```

**Step 5: Verify the web client builds**

Run: `bunx tsc --noEmit`
Expected: No errors (or only warnings)

**Step 6: Commit**

```bash
git add clients/web/src/
git rm clients/web/src/components/MessageNode.tsx
git commit -m "refactor: web client uses thread projection — dumb components, no selectors"
```

---

### Task 7: Update CLI Client

**Files:**
- Rewrite: `clients/cli/index.tsx`

**Step 1: Update imports and rendering**

Replace selector imports with `projectThread`. Rewrite `NodeView` to render `ViewNode` instead of traversing the graph. Update `buildApiMessages` to use the projection.

Key changes:
- Import `projectThread, type ViewNode, type ViewContent` instead of selectors
- Replace `getRoots(conversation().graph)` with `projectThread(conversation().graph)`
- Rewrite `NodeView` to accept `ViewNode` props
- Rewrite `BlockView` to accept `ViewContent` props
- Remove `getErrorMessages` helper (errors handled via node status)
- Rewrite `buildApiMessages` to walk `ViewNode[]`

**Step 2: Verify CLI compiles**

Run: `bunx tsc --noEmit clients/cli/index.tsx`

**Step 3: Commit**

```bash
git add clients/cli/index.tsx
git commit -m "refactor: CLI client uses thread projection"
```

---

### Task 8: Update Remaining Tests

**Files:**
- Update or delete: `packages/ai/client/__tests__/nested-subagent.test.ts`
- Update or delete: `packages/ai/client/__tests__/nested-render-count.test.ts`
- Update: `packages/ai/client/__tests__/client-integration.test.ts`
- Update: `packages/ai/client/__tests__/conversation.integration.test.ts`

These tests use old selectors (`getRoots`, `getChildren`, `getContentBlocks`, `getText`). They need to be updated to either:
- Use `projectThread()` to verify the view output, or
- Assert directly against `graph.nodes` and `graph.edges`

The `nested-render-count.test.ts` was specifically measuring `getChildren` call counts — this test should be deleted since `getChildren` no longer exists.

**Step 1: Delete `nested-render-count.test.ts`**

```bash
rm packages/ai/client/__tests__/nested-render-count.test.ts
```

**Step 2: Update integration tests**

Rewrite assertions in `nested-subagent.test.ts`, `client-integration.test.ts`, and `conversation.integration.test.ts` to use `projectThread()` or direct graph assertions.

Pattern for updating:
```typescript
// Old:
const roots = getRoots(state.graph);
const blocks = getContentBlocks(state.graph, roots[0]!);
expect(blocks[0]!.type).toBe("text");

// New:
const view = projectThread(state.graph);
expect(view[0]!.content.kind).toBe("text");
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass (excluding pre-existing API key failures)

**Step 4: Commit**

```bash
git add packages/ai/client/__tests__/
git rm packages/ai/client/__tests__/nested-render-count.test.ts
git commit -m "refactor: update tests to use new graph types and thread projection"
```

---

### Task 9: Final Verification

**Step 1: Run formatter**

Run: `bun run format`

**Step 2: Run type checker**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Run all tests**

Run: `bun test`
Expected: All tests pass (excluding pre-existing API key failures)

**Step 4: Verify no old symbols remain**

Run: `grep -r "getContentBlocks\|GraphNode\|GraphState\|getChildren\|getRoots\|getToolCalls\|getToolCallCount\|getText\|getUsage\|getStatus\|getRole" packages/ai/client/ clients/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".test.ts"`

Expected: No matches. All old symbols are gone.

**Step 5: Final commit if any formatting changes**

```bash
git add -A
git commit -m "chore: format"
```
