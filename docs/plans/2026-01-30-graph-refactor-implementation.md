# Conversation Graph Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the event-accumulating graph model with a proper directed graph (nodes + adjacency list) and a thread projection layer that converts the graph into a flat view model for React.

**Architecture:** Three layers — (1) Graph Builder: pure reducer that creates one node per content event and builds an adjacency list via same-run sequential ordering and cross-run parentId edges. (2) Thread Projection: pure function `projectThread(graph) → ViewNode[]` that walks the graph and classifies edges as continuations (same runId) or branches (different runId). (3) React Components: dumb renderers that receive `ViewNode[]` and render recursively.

**Tech Stack:** TypeScript, Bun (runtime + test runner), React, Tailwind CSS

**Design doc:** `docs/plans/2026-01-29-graph-refactor-design.md`

---

## Task 1: New Graph types

**Files:**
- Modify: `packages/ai/client/types.ts`

**Step 1: Write the new types**

Replace the entire file. Delete `GraphNode` and `GraphState`. The new types:

```typescript
import type { Permissions } from "../types";

/**
 * A node in the conversation graph.
 * Each node represents one content block — not one "message" or one "run."
 */
export type Node = { id: string; runId: string } & (
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; output: unknown }
  | { kind: "user"; content: string }
  | { kind: "harness_start"; agentId: string }
  | { kind: "harness_end"; agentId: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | {
      kind: "relay";
      relayKind: "permission";
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    }
);

/**
 * The conversation graph.
 * - nodes: all nodes keyed by id
 * - edges: adjacency list (sourceId → targetIds[])
 * - lastNodeByRunId: tracks the most recent node per runId for edge construction
 */
export interface Graph {
  nodes: Map<string, Node>;
  edges: Map<string, string[]>;
  lastNodeByRunId: Map<string, string>;
}
```

**Step 2: Verify the project still type-checks (it will fail — that's expected)**

Run: `bun run check 2>&1 | head -30`
Expected: Type errors in files that import `GraphNode` / `GraphState` (graph.ts, selectors.ts, conversation.ts, index.ts, MessageNode.tsx, etc.)

**Step 3: Commit**

```
feat(ai): define new Graph types with Node union and adjacency list
```

---

## Task 2: New graph reducer

**Files:**
- Modify: `packages/ai/client/graph.ts`
- Modify: `packages/ai/client/__tests__/graph.test.ts`

**Step 1: Write the failing tests**

Replace `packages/ai/client/__tests__/graph.test.ts` entirely. Key test cases:

```typescript
import { describe, test, expect } from "bun:test";
import { createGraph, reduceEvent } from "../graph";
import type { Graph } from "../types";

describe("Graph Reducer", () => {
  test("createGraph returns empty graph", () => {
    const g = createGraph();
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
    expect(g.lastNodeByRunId.size).toBe(0);
  });

  test("reduceEvent ignores connected events", () => {
    const g = createGraph();
    const g2 = reduceEvent(g, { type: "connected", sessionId: "s-1" });
    expect(g2.nodes.size).toBe(0);
  });

  test("text event creates a node", () => {
    const g = reduceEvent(createGraph(), {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Hello",
    });
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("t1")!;
    expect(node.kind).toBe("text");
    expect(node.runId).toBe("r1");
    if (node.kind === "text") expect(node.content).toBe("Hello");
  });

  test("streaming text with same id appends content", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " });
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "world" });
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("t1")!;
    if (node.kind === "text") expect(node.content).toBe("Hello world");
  });

  test("streaming reasoning with same id appends content", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "Think" });
    g = reduceEvent(g, { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "ing" });
    const node = g.nodes.get("r1")!;
    if (node.kind === "reasoning") expect(node.content).toBe("Thinking");
  });

  test("sequential events in same run create edges", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "harness_start", runId: "r1", agentId: "a1" });
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" });
    g = reduceEvent(g, { type: "harness_end", runId: "r1", agentId: "a1" });

    // harness_start → text → harness_end
    const hsId = "r1:harness_start";
    expect(g.edges.get(hsId)).toEqual(["t1"]);
    expect(g.edges.get("t1")).toEqual(["r1:harness_end"]);
  });

  test("parentId creates cross-run edge", () => {
    let g = createGraph();
    // Parent run: tool_call
    g = reduceEvent(g, {
      type: "tool_call", id: "tc1", runId: "r1", agentId: "a1",
      name: "agent", input: { task: "go" },
    });
    // Child run starts with parentId pointing to tc1
    g = reduceEvent(g, {
      type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1",
    });
    // tc1 should have an edge to the child's harness_start
    const tc1Edges = g.edges.get("tc1") ?? [];
    expect(tc1Edges).toContain("r2:harness_start");
  });

  test("tool_call then tool_result in same run creates sequential edge", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "tool_call", id: "tc1", runId: "r1", agentId: "a1",
      name: "bash", input: { cmd: "ls" },
    });
    g = reduceEvent(g, {
      type: "tool_result", id: "tc1", runId: "r1", agentId: "a1",
      name: "bash", output: "file.txt",
    });
    // tool_call → tool_result (sequential in same run)
    expect(g.edges.get("tc1")).toContain("tc1:result");
  });

  test("events without id get deterministic generated ids", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "harness_start", runId: "r1", agentId: "a1" });
    expect(g.nodes.has("r1:harness_start")).toBe(true);

    g = reduceEvent(g, { type: "harness_end", runId: "r1", agentId: "a1" });
    expect(g.nodes.has("r1:harness_end")).toBe(true);

    g = reduceEvent(g, { type: "error", runId: "r1", agentId: "a1", message: "oops" });
    expect(g.nodes.has("r1:error")).toBe(true);
  });

  test("usage events use counter for unique ids", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "usage", runId: "r1", agentId: "a1", inputTokens: 10, outputTokens: 5,
    });
    g = reduceEvent(g, {
      type: "usage", runId: "r1", agentId: "a1", inputTokens: 20, outputTokens: 10,
    });
    expect(g.nodes.size).toBe(2);
  });

  test("state is immutable", () => {
    const g1 = createGraph();
    const g2 = reduceEvent(g1, {
      type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi",
    });
    expect(g1.nodes.size).toBe(0);
    expect(g2.nodes.size).toBe(1);
  });

  test("subagent example from design doc", () => {
    let g = createGraph();
    // Parent agent: text then tool_call
    g = reduceEvent(g, { type: "harness_start", runId: "r2", agentId: "a1" });
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r2", agentId: "a1", content: "Let me search." });
    g = reduceEvent(g, {
      type: "tool_call", id: "tc1", runId: "r2", agentId: "a1",
      name: "search", input: "auth",
    });
    // Subagent starts (parentId = tc1)
    g = reduceEvent(g, { type: "harness_start", runId: "r3", agentId: "a2", parentId: "tc1" });
    g = reduceEvent(g, {
      type: "text", id: "t2", runId: "r3", agentId: "a2", parentId: "tc1",
      content: "Searching...",
    });
    g = reduceEvent(g, { type: "harness_end", runId: "r3", agentId: "a2", parentId: "tc1" });
    // Parent continues: tool_result then more text
    g = reduceEvent(g, {
      type: "tool_result", id: "tc1", runId: "r2", agentId: "a1",
      name: "search", output: ["auth.ts"],
    });
    g = reduceEvent(g, { type: "text", id: "t3", runId: "r2", agentId: "a1", content: "Found auth.ts" });
    g = reduceEvent(g, { type: "harness_end", runId: "r2", agentId: "a1" });

    // Verify edge structure
    // tc1 should have edges to both:
    //   - r3:harness_start (cross-run via parentId)
    //   - tc1:result (sequential in r2)
    const tc1Edges = g.edges.get("tc1") ?? [];
    expect(tc1Edges).toContain("r3:harness_start");
    expect(tc1Edges).toContain("tc1:result");
  });

  test("user event creates user node", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "user", runId: "u1", content: "Hello",
    } as any); // UserEvent, not ServerEvent — reducer must accept both
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("u1:user")!;
    expect(node.kind).toBe("user");
  });

  test("relay event creates relay node", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "relay", kind: "permission", id: "relay-1",
      runId: "r1", agentId: "a1",
      toolCallId: "tc1", tool: "bash", params: { command: "rm" },
    });
    expect(g.nodes.has("relay-1")).toBe(true);
    const node = g.nodes.get("relay-1")!;
    expect(node.kind).toBe("relay");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: FAIL — `createGraph` and new `reduceEvent` don't exist yet.

**Step 3: Implement the reducer**

Replace `packages/ai/client/graph.ts` entirely:

```typescript
import type { ServerEvent } from "./server-event";
import type { Graph, Node } from "./types";

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string;
};

export type GraphEvent = ServerEvent | UserEvent;

export function createGraph(): Graph {
  return {
    nodes: new Map(),
    edges: new Map(),
    lastNodeByRunId: new Map(),
  };
}

/** Counter for generating unique IDs for usage events (multiple per run). */
let usageCounter = 0;

function deriveNodeId(event: GraphEvent): string | null {
  switch (event.type) {
    case "connected":
      return null; // skip
    case "text":
    case "reasoning":
      return event.id; // stable across streaming deltas
    case "tool_call":
      return event.id;
    case "tool_result":
      return `${event.id}:result`;
    case "relay":
      return event.id;
    case "harness_start":
      return `${event.runId}:harness_start`;
    case "harness_end":
      return `${event.runId}:harness_end`;
    case "error":
      return `${event.runId}:error`;
    case "usage":
      return `${event.runId}:usage:${++usageCounter}`;
    case "user":
      return `${event.runId}:user`;
    default:
      return null;
  }
}

function eventToNode(id: string, event: GraphEvent): Node {
  const runId = event.runId;
  switch (event.type) {
    case "text":
      return { id, runId, kind: "text", content: event.content };
    case "reasoning":
      return { id, runId, kind: "reasoning", content: event.content };
    case "tool_call":
      return { id, runId, kind: "tool_call", name: event.name, input: event.input };
    case "tool_result":
      return { id, runId, kind: "tool_result", name: event.name, output: event.output };
    case "harness_start":
      return { id, runId, kind: "harness_start", agentId: event.agentId };
    case "harness_end":
      return { id, runId, kind: "harness_end", agentId: event.agentId };
    case "error":
      return { id, runId, kind: "error", message: event.message };
    case "usage":
      return { id, runId, kind: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    case "relay":
      return {
        id, runId, kind: "relay", relayKind: event.kind,
        toolCallId: event.toolCallId, tool: event.tool, params: event.params,
      };
    case "user":
      return { id, runId, kind: "user", content: event.content };
    default:
      throw new Error(`Unknown event type: ${(event as any).type}`);
  }
}

function addEdge(edges: Map<string, string[]>, from: string, to: string): void {
  const existing = edges.get(from);
  if (existing) {
    existing.push(to);
  } else {
    edges.set(from, [to]);
  }
}

export function reduceEvent(graph: Graph, event: GraphEvent): Graph {
  const nodeId = deriveNodeId(event);
  if (nodeId === null) return graph;

  const runId = event.runId;

  // Clone for immutability
  const nodes = new Map(graph.nodes);
  const edges = new Map(graph.edges);
  // Deep-clone edge arrays that we might mutate
  for (const [k, v] of graph.edges) {
    edges.set(k, [...v]);
  }
  const lastNodeByRunId = new Map(graph.lastNodeByRunId);

  // Check if this is a streaming update to an existing node
  const existingNode = nodes.get(nodeId);
  if (existingNode) {
    // Streaming text/reasoning: append content
    if (
      (existingNode.kind === "text" && event.type === "text") ||
      (existingNode.kind === "reasoning" && event.type === "reasoning")
    ) {
      nodes.set(nodeId, { ...existingNode, content: existingNode.content + event.content });
      // No new edges — node already exists in the graph
      return { nodes, edges, lastNodeByRunId };
    }
    // Other duplicate id — ignore (shouldn't happen)
    return graph;
  }

  // Create new node
  const node = eventToNode(nodeId, event);
  nodes.set(nodeId, node);

  // Edge from previous node in same runId (sequential ordering)
  const prevInRun = graph.lastNodeByRunId.get(runId);
  if (prevInRun) {
    addEdge(edges, prevInRun, nodeId);
  }

  // Edge from parentId (cross-run spawn)
  const parentId = "parentId" in event ? (event as { parentId?: string }).parentId : undefined;
  if (parentId) {
    // Only add cross-run edge on the FIRST event of a new run entering the graph.
    // Subsequent events in the same child run are linked via sequential ordering above.
    if (!prevInRun) {
      addEdge(edges, parentId, nodeId);
    }
  }

  // Update lastNodeByRunId
  lastNodeByRunId.set(runId, nodeId);

  return { nodes, edges, lastNodeByRunId };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/graph.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```
feat(ai): implement new graph reducer with adjacency list edges
```

---

## Task 3: Thread projection

**Files:**
- Create: `packages/ai/client/projections/thread.ts`
- Create: `packages/ai/client/__tests__/projections/thread.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from "bun:test";
import { createGraph, reduceEvent, type GraphEvent } from "../../graph";
import { projectThread } from "../../projections/thread";
import type { ViewNode } from "../../projections/thread";

function buildGraph(events: GraphEvent[]) {
  let g = createGraph();
  for (const e of events) g = reduceEvent(g, e);
  return g;
}

describe("Thread Projection", () => {
  test("empty graph produces empty view", () => {
    expect(projectThread(createGraph())).toEqual([]);
  });

  test("simple text response produces flat list", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(1);
    expect(view[0]!.content.kind).toBe("text");
    if (view[0]!.content.kind === "text") expect(view[0]!.content.text).toBe("Hello");
    expect(view[0]!.status).toBe("complete");
    expect(view[0]!.branches).toEqual([]);
  });

  test("consecutive text nodes merge into one ViewNode", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "world" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    // Two text nodes with same runId should merge
    const textNodes = view.filter((v) => v.content.kind === "text");
    expect(textNodes.length).toBe(1);
    if (textNodes[0]!.content.kind === "text") {
      expect(textNodes[0]!.content.text).toBe("Hello world");
    }
  });

  test("reasoning then text produces two ViewNodes", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "reasoning", id: "r1x", runId: "r1", agentId: "a1", content: "Hmm" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Answer" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(2);
    expect(view[0]!.content.kind).toBe("reasoning");
    expect(view[1]!.content.kind).toBe("text");
  });

  test("tool_call with subagent creates branch", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Searching" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "search", input: "auth" },
      // Subagent
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", parentId: "tc1", content: "Found it" },
      { type: "harness_end", runId: "r2", agentId: "a2", parentId: "tc1" },
      // Parent continues
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "search", output: ["auth.ts"] },
      { type: "text", id: "t3", runId: "r1", agentId: "a1", content: "Done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);

    // Find the tool_call ViewNode
    const tcNode = view.find((v) => v.content.kind === "tool_call");
    expect(tcNode).toBeDefined();
    expect(tcNode!.branches.length).toBe(1); // one subagent branch
    expect(tcNode!.branches[0]!.length).toBeGreaterThan(0); // branch has content
    // tool_call should have output attached
    if (tcNode!.content.kind === "tool_call") {
      expect(tcNode!.content.output).toEqual(["auth.ts"]);
    }
  });

  test("status is streaming when harness_start without harness_end", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "typing..." },
    ]);
    const view = projectThread(g);
    expect(view[0]!.status).toBe("streaming");
  });

  test("status is error when error node present", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "error", runId: "r1", agentId: "a1", message: "boom" },
    ]);
    const view = projectThread(g);
    // Should have error ViewNode
    const errorNode = view.find((v) => v.status === "error");
    expect(errorNode).toBeDefined();
  });

  test("user event produces user ViewNode", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" } as any,
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(1);
    expect(view[0]!.role).toBe("user");
    expect(view[0]!.content.kind).toBe("user");
  });

  test("disconnected components render in insertion order", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" } as any,
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
      { type: "user", runId: "u2", content: "Follow-up" } as any,
      { type: "harness_start", runId: "r2", agentId: "a2" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", content: "Sure" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
    ]);
    const view = projectThread(g);
    // Should have 4 top-level items: user, text, user, text
    expect(view.length).toBe(4);
    expect(view[0]!.role).toBe("user");
    expect(view[1]!.role).toBe("assistant");
    expect(view[2]!.role).toBe("user");
    expect(view[3]!.role).toBe("assistant");
  });

  test("parallel subagents create multiple branches", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "search", input: "x" },
      // Two subagents spawned from same tool_call
      { type: "harness_start", runId: "r2a", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t2a", runId: "r2a", agentId: "a2", parentId: "tc1", content: "A" },
      { type: "harness_end", runId: "r2a", agentId: "a2", parentId: "tc1" },
      { type: "harness_start", runId: "r2b", agentId: "a3", parentId: "tc1" },
      { type: "text", id: "t2b", runId: "r2b", agentId: "a3", parentId: "tc1", content: "B" },
      { type: "harness_end", runId: "r2b", agentId: "a3", parentId: "tc1" },
      // Parent continues
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "search", output: "done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNode = view.find((v) => v.content.kind === "tool_call");
    expect(tcNode).toBeDefined();
    expect(tcNode!.branches.length).toBe(2); // two parallel subagents
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/projections/thread.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the projection**

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
  | { kind: "tool_call"; name: string; input: unknown; output?: unknown }
  | { kind: "user"; text: string }
  | { kind: "error"; message: string }
  | {
      kind: "relay";
      relayKind: "permission";
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

function nodeToViewContent(node: Node): ViewContent | null {
  switch (node.kind) {
    case "text":
      return { kind: "text", text: node.content };
    case "reasoning":
      return { kind: "reasoning", text: node.content };
    case "tool_call":
      return { kind: "tool_call", name: node.name, input: node.input };
    case "user":
      return { kind: "user", text: node.content };
    case "error":
      return { kind: "error", message: node.message };
    case "relay":
      return {
        kind: "relay",
        relayKind: node.relayKind,
        toolCallId: node.toolCallId,
        tool: node.tool,
        params: node.params,
      };
    // harness_start, harness_end, usage, tool_result: no direct ViewContent
    default:
      return null;
  }
}

function deriveRunStatus(graph: Graph, runId: string): "streaming" | "complete" | "error" {
  for (const node of graph.nodes.values()) {
    if (node.runId !== runId) continue;
    if (node.kind === "error") return "error";
  }
  if (graph.nodes.has(`${runId}:harness_end`)) return "complete";
  if (graph.nodes.has(`${runId}:harness_start`)) return "streaming";
  return "complete";
}

/**
 * Find root node IDs — nodes with no incoming edges, preserving insertion order.
 * A "root" here means: the first node in each connected component.
 */
function findRoots(graph: Graph): string[] {
  // Build set of all nodes that ARE targets of edges
  const hasIncoming = new Set<string>();
  for (const targets of graph.edges.values()) {
    for (const target of targets) {
      hasIncoming.add(target);
    }
  }
  // Roots are nodes with no incoming edges
  const roots: string[] = [];
  for (const id of graph.nodes.keys()) {
    if (!hasIncoming.has(id)) {
      roots.push(id);
    }
  }
  return roots;
}

/**
 * Walk a chain of nodes starting from `startId`, following same-runId edges.
 * Returns { viewNodes, branches } where branches are grouped by runId.
 */
function walkRun(graph: Graph, startId: string, visited: Set<string>): ViewNode[] {
  const result: ViewNode[] = [];
  let currentId: string | null = startId;

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const node = graph.nodes.get(currentId);
    if (!node) break;

    const content = nodeToViewContent(node);
    const edges = graph.edges.get(currentId) ?? [];

    // Classify outgoing edges
    let continuation: string | null = null;
    const branchTargets: Map<string, string[]> = new Map(); // runId → nodeIds

    for (const targetId of edges) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode || visited.has(targetId)) continue;

      if (targetNode.runId === node.runId) {
        // Same run → continuation (pick first, shouldn't have multiples)
        continuation = targetId;
      } else {
        // Different run → branch
        const existing = branchTargets.get(targetNode.runId) ?? [];
        existing.push(targetId);
        branchTargets.set(targetNode.runId, existing);
      }
    }

    // Handle tool_result: attach output to preceding tool_call
    if (node.kind === "tool_result") {
      // Find the tool_call ViewNode in result and attach output
      for (let i = result.length - 1; i >= 0; i--) {
        const vn = result[i]!;
        if (vn.content.kind === "tool_call" && currentId === `${vn.id}:result`) {
          vn.content = { ...vn.content, output: node.output };
          break;
        }
      }
      // Don't emit tool_result as its own ViewNode
      currentId = continuation;
      continue;
    }

    if (content) {
      // Merge consecutive same-kind text/reasoning
      const prev = result[result.length - 1];
      if (
        prev &&
        prev.runId === node.runId &&
        prev.content.kind === content.kind &&
        (content.kind === "text" || content.kind === "reasoning")
      ) {
        // Merge into previous
        prev.content = {
          ...prev.content,
          text: (prev.content as { text: string }).text + (content as { text: string }).text,
        };
        // Branches from this node get added to the previous ViewNode
        for (const [branchRunId, branchStartIds] of branchTargets) {
          for (const bStartId of branchStartIds) {
            prev.branches.push(walkRun(graph, bStartId, visited));
          }
        }
      } else {
        // Build branches
        const branches: ViewNode[][] = [];
        for (const [, branchStartIds] of branchTargets) {
          for (const bStartId of branchStartIds) {
            branches.push(walkRun(graph, bStartId, visited));
          }
        }

        result.push({
          id: node.id,
          runId: node.runId,
          role: node.kind === "user" ? "user" : "assistant",
          content,
          status: deriveRunStatus(graph, node.runId),
          branches,
        });
      }
    } else {
      // Non-content node (harness_start, harness_end, usage) — skip but recurse branches
      for (const [, branchStartIds] of branchTargets) {
        for (const bStartId of branchStartIds) {
          // Branches from non-content nodes get prepended to result
          result.push(...walkRun(graph, bStartId, visited));
        }
      }
    }

    currentId = continuation;
  }

  return result;
}

export function projectThread(graph: Graph): ViewNode[] {
  if (graph.nodes.size === 0) return [];

  const visited = new Set<string>();
  const roots = findRoots(graph);
  const result: ViewNode[] = [];

  for (const rootId of roots) {
    result.push(...walkRun(graph, rootId, visited));
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/projections/thread.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```
feat(ai): implement thread projection (Graph → ViewNode[])
```

---

## Task 4: Update conversation layer

**Files:**
- Modify: `packages/ai/client/conversation.ts`
- Modify: `packages/ai/client/__tests__/conversation.test.ts`

**Step 1: Write the failing tests**

Replace `packages/ai/client/__tests__/conversation.test.ts`. The tests now assert against `Graph` (not `GraphState`) and don't use selectors. Key changes:
- `state.graph.nodes` is now `Map<string, Node>` (not `Map<string, GraphNode>`)
- No more `getRole`, `getContentBlocks`, `getChildren` from selectors
- User events produce `kind: "user"` nodes directly (no synthetic text events)
- `state.graph.edges` exists

```typescript
import { describe, test, expect } from "bun:test";
import {
  createInitialConversation,
  reduceConversation,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "../conversation";

describe("Conversation Reducer", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
    expect(state.graph.edges.size).toBe(0);
    expect(state.sessionId).toBe(null);
    expect(state.pendingRelays).toEqual([]);
    expect(state.grantedTools.size).toBe(0);
    expect(state.activeStreams.size).toBe(0);
    expect(state.isConnected).toBe(false);
  });

  test("connected event sets sessionId", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "connected", sessionId: "s-1" });
    expect(state.sessionId).toBe("s-1");
    expect(state.graph.nodes.size).toBe(0);
  });

  test("user event creates user node in graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "user", runId: "u1", content: "Hello" });
    expect(state.graph.nodes.size).toBe(1);
    const node = state.graph.nodes.get("u1:user")!;
    expect(node.kind).toBe("user");
    if (node.kind === "user") expect(node.content).toBe("Hello");
  });

  test("text event delegates to graph reducer", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello",
    });
    expect(state.graph.nodes.size).toBe(1);
    expect(state.graph.nodes.get("t1")!.kind).toBe("text");
  });

  test("relay event appends to pendingRelays and creates graph node", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "r1", agentId: "a1",
      toolCallId: "tc-1", tool: "bash", params: { command: "rm -rf" },
    });
    expect(state.pendingRelays.length).toBe(1);
    expect(state.pendingRelays[0]!.relayId).toBe("r-1");
    expect(state.graph.nodes.has("r-1")).toBe(true);
  });

  test("relay_resolved removes relay and grants tool if approved", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "r1", agentId: "a1",
      toolCallId: "tc-1", tool: "bash", params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved", relayId: "r-1", tool: "bash", approved: true,
    });
    expect(state.pendingRelays.length).toBe(0);
    expect(state.grantedTools.has("bash")).toBe(true);
  });

  test("harness_start adds to activeStreams and delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "harness_start", runId: "r1", agentId: "a1" });
    expect(state.activeStreams.has("r1")).toBe(true);
    expect(state.graph.nodes.has("r1:harness_start")).toBe(true);
  });

  test("harness_end removes from activeStreams and delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "harness_start", runId: "r1", agentId: "a1" });
    state = reduceConversation(state, { type: "harness_end", runId: "r1", agentId: "a1" });
    expect(state.activeStreams.has("r1")).toBe(false);
    expect(state.graph.nodes.has("r1:harness_end")).toBe(true);
  });

  test("stream_start/stream_end toggle isConnected", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);
    state = reduceConversation(state, { type: "stream_end" });
    expect(state.isConnected).toBe(false);
  });

  test("getAutoApprovableRelays returns relays whose tool is already granted", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-0", runId: "r1", agentId: "a1",
      toolCallId: "tc-0", tool: "read_file", params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved", relayId: "r-0", tool: "read_file", approved: true,
    });
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "r1", agentId: "a1",
      toolCallId: "tc-1", tool: "read_file", params: { path: "/a" },
    });
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-2", runId: "r1", agentId: "a1",
      toolCallId: "tc-2", tool: "bash", params: { command: "ls" },
    });
    const auto = getAutoApprovableRelays(state);
    expect(auto.length).toBe(1);
    expect(auto[0]!.relayId).toBe("r-1");
  });

  test("getSameToolRelays returns all pending relays matching a tool type", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-1", runId: "r1", agentId: "a1",
      toolCallId: "tc-1", tool: "read_file", params: {},
    });
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-2", runId: "r1", agentId: "a1",
      toolCallId: "tc-2", tool: "read_file", params: {},
    });
    state = reduceConversation(state, {
      type: "relay", kind: "permission", id: "r-3", runId: "r1", agentId: "a1",
      toolCallId: "tc-3", tool: "bash", params: {},
    });
    const same = getSameToolRelays(state, "read_file");
    expect(same.length).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: FAIL — old types don't match.

**Step 3: Update conversation.ts**

```typescript
import type { ServerEvent } from "./server-event";
import type { Graph } from "./types";
import { createGraph, reduceEvent, type GraphEvent } from "./graph";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: Graph;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;
  isConnected: boolean;
}

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string;
  timestamp?: number;
};

export type ConversationEvent =
  | ServerEvent
  | UserEvent
  | { type: "stream_start" }
  | { type: "stream_end" }
  | { type: "relay_resolved"; relayId: string; tool: string; approved: boolean };

export function createInitialConversation(): ConversationState {
  return {
    graph: createGraph(),
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
      return { ...state, graph: reduceEvent(state.graph, event as GraphEvent) };

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
        graph: reduceEvent(state.graph, event),
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
      return { ...state, activeStreams, graph: reduceEvent(state.graph, event) };
    }

    case "harness_end": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.delete(event.runId);
      return { ...state, activeStreams, graph: reduceEvent(state.graph, event) };
    }

    default:
      return { ...state, graph: reduceEvent(state.graph, event as ServerEvent) };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/__tests__/conversation.test.ts`
Expected: All tests PASS.

**Step 5: Commit**

```
refactor(ai): update conversation layer for new Graph type
```

---

## Task 5: Update barrel exports and delete selectors

**Files:**
- Delete: `packages/ai/client/selectors.ts`
- Delete: `packages/ai/client/__tests__/selectors.test.ts`
- Modify: `packages/ai/client/index.ts`
- Modify: `clients/web/src/types.ts`

**Step 1: Update index.ts**

```typescript
// Core graph
export { createGraph, reduceEvent } from "./graph";
export type { GraphEvent } from "./graph";

// Conversation layer
export {
  createInitialConversation,
  reduceConversation,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "./conversation";

// Projection
export { projectThread } from "./projections/thread";
export type { ViewNode, ViewContent } from "./projections/thread";

// Types
export type { Graph, Node } from "./types";
export type { PendingRelay, ConversationState, ConversationEvent } from "./conversation";
export type { ServerEvent, StreamRequest } from "./server-event";

// Transports
export { createSSETransport } from "./transports/sse";
export { createHTTPTransport } from "./transports/http";
```

**Step 2: Delete selectors.ts and selectors.test.ts**

Delete the files:
- `packages/ai/client/selectors.ts`
- `packages/ai/client/__tests__/selectors.test.ts`

**Step 3: Update clients/web/src/types.ts**

```typescript
export type { ServerEvent } from "../../../packages/ai/client/server-event";
export type { ConversationState, PendingRelay } from "../../../packages/ai/client";
export type { Graph, Node } from "../../../packages/ai/client";
export type { ViewNode, ViewContent } from "../../../packages/ai/client";

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

**Step 4: Verify graph + conversation tests pass**

Run: `bun test packages/ai/client/__tests__/graph.test.ts packages/ai/client/__tests__/conversation.test.ts packages/ai/client/__tests__/projections/thread.test.ts`
Expected: All PASS.

**Step 5: Commit**

```
refactor(ai): delete selectors and update barrel exports
```

---

## Task 6: Replace React components

**Files:**
- Delete: `clients/web/src/components/MessageNode.tsx`
- Modify: `clients/web/src/components/ConversationThread.tsx`
- Modify: `clients/web/src/App.tsx`

**Step 1: Replace ConversationThread.tsx**

This now calls `projectThread(graph)` and renders `ViewNode[]`. It includes the Thread component and content rendering inline since these are tightly coupled rendering concerns.

```tsx
import { useState, useRef, useEffect, memo } from "react";
import { projectThread } from "../../../../packages/ai/client";
import type { ViewNode, ViewContent, Graph, PendingRelay } from "../types";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface ConversationThreadProps {
  graph: Graph;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function ContentView({ content }: { content: ViewContent }) {
  switch (content.kind) {
    case "user":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "text":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "reasoning":
      return <div className="mt-1 text-sm italic text-gray-500">{content.text}</div>;
    case "error":
      return (
        <div className="mt-1 rounded border border-red-700 bg-red-900/20 p-2 text-sm text-red-400">
          {content.message}
        </div>
      );
    case "relay":
      // Relays are rendered by PermissionPrompt via pendingRelays, not here
      return null;
    case "tool_call":
      return <ToolCallView content={content} />;
  }
}

function ToolCallView({
  content,
}: {
  content: Extract<ViewContent, { kind: "tool_call" }>;
}) {
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
          <pre className="whitespace-pre-wrap break-words text-gray-300">{outputStr}</pre>
        </div>
      )}
    </div>
  );
}

const ViewNodeComponent = memo(function ViewNodeComponent({
  node,
  pendingRelays,
  permissionHandlers,
}: {
  node: ViewNode;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  const isUser = node.role === "user";
  const isStreaming = node.status === "streaming";
  const nodeRelays = pendingRelays.filter((r) => r.runId === node.runId);

  return (
    <div className="mb-4">
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${node.runId.slice(0, 8)}`}
        {isStreaming && (
          <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
        )}
      </div>
      <ContentView content={node.content} />
      {nodeRelays.map((relay) => (
        <PermissionPromptInline
          key={relay.relayId}
          request={relay}
          onAllow={() => permissionHandlers.onAllow(relay)}
          onAllowAll={() => permissionHandlers.onAllowAll(relay)}
          onDeny={() => permissionHandlers.onDeny(relay)}
        />
      ))}
      {node.branches.map((branch, i) => (
        <BranchView
          key={i}
          branch={branch}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
    </div>
  );
});

function BranchView({
  branch,
  pendingRelays,
  permissionHandlers,
}: {
  branch: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  const isStreaming = branch.some((n) => n.status === "streaming");

  // Auto-show when streaming, collapse when done
  if (branch.length === 0) return null;

  if (!expanded && !isStreaming) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1 w-full rounded bg-gray-700 px-2 py-1 text-left text-xs text-gray-400 hover:bg-gray-600 hover:text-gray-200"
      >
        {branch.length} node{branch.length !== 1 ? "s" : ""} in subthread
      </button>
    );
  }

  return (
    <div className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
      {!isStreaming && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mb-1 text-xs text-gray-400 hover:text-gray-200"
        >
          Collapse
        </button>
      )}
      <Thread
        nodes={branch}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
      />
    </div>
  );
}

function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  return (
    <>
      {nodes.map((node) => (
        <ViewNodeComponent
          key={node.id}
          node={node}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
    </>
  );
}

function PermissionPromptInline({
  request,
  onAllow,
  onAllowAll,
  onDeny,
}: {
  request: PendingRelay;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const paramsStr = JSON.stringify(request.params, null, 2);

  return (
    <div ref={ref} className="my-4 rounded border border-yellow-600 bg-yellow-900/20 p-4">
      <div className="mb-2 font-medium text-yellow-400">Permission Required</div>
      <div className="mb-2 text-sm text-gray-300">
        Tool: <span className="font-mono text-yellow-300">{request.tool}</span>
      </div>
      <pre className="mb-4 overflow-x-auto rounded bg-gray-800 p-2 text-sm text-gray-400">
        {paramsStr}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={onAllow}
          className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
        >
          Allow
        </button>
        <button
          onClick={onAllowAll}
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
        >
          Always Allow
        </button>
        <button
          onClick={onDeny}
          className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export function ConversationThread({
  graph,
  pendingRelays,
  permissionHandlers,
  scrollContainerRef,
}: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const viewNodes = projectThread(graph);

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
  }, [graph, pendingRelays]);

  if (viewNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Thread
        nodes={viewNodes}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
      />
      <div ref={bottomRef} />
    </div>
  );
}
```

**Step 2: Delete MessageNode.tsx and PermissionPrompt.tsx**

Delete:
- `clients/web/src/components/MessageNode.tsx`
- `clients/web/src/components/PermissionPrompt.tsx`

(PermissionPrompt is now inlined in ConversationThread.tsx)

**Step 3: Update App.tsx**

Remove all selector imports and the `buildMessagesFromGraph` function. Replace it with a projection-based approach:

```tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import type { PermissionHandlers } from "./components/ConversationThread";
import {
  createSSETransport,
  createHTTPTransport,
  projectThread,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "../../../packages/ai/client";
import { reduceConversation, createInitialConversation } from "../../../packages/ai/client";
import type { ConversationState, Message, PendingRelay, Permissions, ServerEvent } from "./types";

declare const __LLM_MODEL__: string | undefined;
const MODEL = __LLM_MODEL__ ?? "kimi-k2.5";

const sseTransport = createSSETransport({ baseUrl: "" });
const httpTransport = createHTTPTransport({ baseUrl: "" });

let userIdCounter = 0;
function nextUserId(): string {
  return `user-${++userIdCounter}`;
}

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialConversation);
  const [streamError, setStreamError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  function buildMessagesFromGraph(graph: ConversationState["graph"]): Message[] {
    const messages: Message[] = [];
    const viewNodes = projectThread(graph);
    const collect = (nodes: typeof viewNodes) => {
      for (const node of nodes) {
        if (node.content.kind === "text" || node.content.kind === "user") {
          messages.push({ role: node.role, content: node.content.text });
        }
        for (const branch of node.branches) {
          collect(branch);
        }
      }
    };
    collect(viewNodes);
    return messages;
  }

  const sendChat = useCallback(async (messages: Message[], permissions: Permissions) => {
    setState((s) => reduceConversation(s, { type: "stream_start" }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const pendingEvents: ServerEvent[] = [];
    let rafId: number | undefined;

    const flushPending = () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = undefined;
      if (pendingEvents.length > 0) {
        const batch = pendingEvents.splice(0);
        setState((s) => {
          let current = s;
          for (const e of batch) {
            current = reduceConversation(current, e);
          }
          return current;
        });
      }
    };

    try {
      const stream = sseTransport.stream(
        { model: MODEL, messages, permissions },
        controller.signal,
      );

      for await (const event of stream) {
        pendingEvents.push(event);
        if (rafId === undefined) {
          rafId = requestAnimationFrame(() => {
            rafId = undefined;
            const batch = pendingEvents.splice(0);
            setState((s) => {
              let current = s;
              for (const e of batch) {
                current = reduceConversation(current, e);
              }
              return current;
            });
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Stream error:", error);
        setStreamError(error.message);
      }
    } finally {
      flushPending();
      setState((s) => reduceConversation(s, { type: "stream_end" }));
      abortControllerRef.current = null;
    }
  }, []);

  const handleSubmit = useCallback(
    async (content: string) => {
      setStreamError(null);
      const userId = nextUserId();

      setState((s) => reduceConversation(s, { type: "user", runId: userId, content }));

      const current = stateRef.current;
      const messages = buildMessagesFromGraph(current.graph);
      messages.push({ role: "user", content });

      const permissions: Permissions = {
        allowlist: Array.from(current.grantedTools).map((tool) => ({ tool })),
      };

      await sendChat(messages, permissions);
    },
    [sendChat],
  );

  const handleAllow = useCallback(
    async (relay: PendingRelay) => {
      if (!state.sessionId) return;
      setState((s) =>
        reduceConversation(s, {
          type: "relay_resolved", relayId: relay.relayId, tool: relay.tool, approved: false,
        }),
      );
      await httpTransport.resolveRelay(state.sessionId, relay.relayId, { approved: true });
    },
    [state.sessionId],
  );

  const handleAllowAll = useCallback(
    async (relay: PendingRelay) => {
      if (!state.sessionId) return;
      const sameTypeRelays = getSameToolRelays(state, relay.tool);
      setState((s) => {
        let current = s;
        for (const r of sameTypeRelays) {
          current = reduceConversation(current, {
            type: "relay_resolved", relayId: r.relayId, tool: r.tool,
            approved: r.relayId === relay.relayId,
          });
        }
        return current;
      });
      const sessionId = state.sessionId;
      await Promise.all(
        sameTypeRelays.map((r) =>
          httpTransport.resolveRelay(sessionId, r.relayId, { approved: true }),
        ),
      );
    },
    [state.sessionId, state.pendingRelays],
  );

  const handleDeny = useCallback(
    async (relay: PendingRelay) => {
      if (!state.sessionId) return;
      setState((s) =>
        reduceConversation(s, {
          type: "relay_resolved", relayId: relay.relayId, tool: relay.tool, approved: false,
        }),
      );
      await httpTransport.resolveRelay(state.sessionId, relay.relayId, {
        approved: false, reason: "User denied",
      });
    },
    [state.sessionId],
  );

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const permissionHandlers: PermissionHandlers = {
    onAllow: handleAllow,
    onAllowAll: handleAllowAll,
    onDeny: handleDeny,
  };

  useEffect(() => {
    if (!state.sessionId) return;
    const autoApprovable = getAutoApprovableRelays(state);
    if (autoApprovable.length === 0) return;
    setState((s) => {
      let current = s;
      for (const r of autoApprovable) {
        current = reduceConversation(current, {
          type: "relay_resolved", relayId: r.relayId, tool: r.tool, approved: false,
        });
      }
      return current;
    });
    const sessionId = state.sessionId;
    for (const r of autoApprovable) {
      httpTransport.resolveRelay(sessionId, r.relayId, { approved: true });
    }
  }, [state.pendingRelays, state.grantedTools, state.sessionId]);

  const isStreaming = state.isConnected;

  return (
    <div className="flex h-dvh flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main ref={scrollContainerRef} className="flex-1 overflow-auto p-3 sm:p-4">
        <ConversationThread
          graph={state.graph}
          pendingRelays={state.pendingRelays}
          permissionHandlers={permissionHandlers}
          scrollContainerRef={scrollContainerRef}
        />
        {streamError && (
          <div className="mt-4 rounded border border-red-600 bg-red-900/20 p-3 text-sm text-red-400">
            Connection error: {streamError}
          </div>
        )}
      </main>
      <InputArea
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        disabled={isStreaming || state.pendingRelays.length > 0}
        isStreaming={isStreaming}
      />
    </div>
  );
}
```

**Step 4: Verify type check passes**

Run: `bun run check`
Expected: No type errors.

**Step 5: Commit**

```
refactor(web): replace MessageNode with projection-based Thread rendering
```

---

## Task 7: Update integration tests

**Files:**
- Modify: `packages/ai/client/__tests__/conversation.integration.test.ts`
- Modify: `packages/ai/client/__tests__/nested-subagent.test.ts`
- Modify: `packages/ai/client/__tests__/nested-render-count.test.ts`

These tests import old selectors (`getRoots`, `getChildren`, `getContentBlocks`, `getRole`, `getText`). They need to be updated to use `projectThread` instead.

**Step 1: Update conversation.integration.test.ts**

Replace all selector usage with `projectThread`. Instead of `getRoots` + `getChildren` traversal, call `projectThread(state.graph)` and inspect the `ViewNode[]`. Replace `getText` / `getContentBlocks` assertions with `ViewNode.content` checks.

Key patterns for migration:
- `getRoots(state.graph)` → `projectThread(state.graph)` (returns top-level ViewNodes)
- `getText(state.graph, runId)` → find ViewNode by runId, read `.content.text`
- `getContentBlocks(state.graph, runId)` → find ViewNode by runId, read `.content`
- `getRole(state.graph, runId)` → find ViewNode by runId, read `.role`
- `getChildren(state.graph, runId)` → find ViewNode by runId, read `.branches`

**Step 2: Update nested-subagent.test.ts**

Replace the `simulateMessageNode` traversal with `projectThread`. The reachability check becomes: all graph nodes with renderable content should appear somewhere in the projected ViewNode tree.

**Step 3: Update nested-render-count.test.ts**

This test measured `getChildren` call counts to detect quadratic blowup. With the new model, the equivalent check is that `projectThread` completes in bounded time and produces correct output. Replace the `simulateUITraversal` function with direct `projectThread` calls and verify:
- No duplicate nodes in output
- All content-bearing nodes appear in the projection
- Linear chain of N agents produces linear output

**Step 4: Run all tests**

Run: `bun test`
Expected: All tests PASS.

**Step 5: Run format and check**

Run: `bun run format && bun run check`
Expected: Clean.

**Step 6: Commit**

```
test(ai): update integration tests for new graph + projection model
```

---

## Task 8: Final cleanup

**Files:**
- Delete: `clients/web/src/components/PermissionPrompt.tsx` (if not already deleted in Task 6)
- Delete: `clients/web/src/components/ErrorBoundary.tsx` (if unused — check first)
- Verify: no stale imports remain

**Step 1: Verify all tests pass**

Run: `bun test`
Expected: All PASS, no console.log noise (tests should be quiet on success per CLAUDE.md).

**Step 2: Remove any console.log from tests**

The existing nested-render-count tests have `console.log` statements. Remove them — tests should only output on failure.

**Step 3: Run format and check**

Run: `bun run format && bun run check`
Expected: Clean.

**Step 4: Commit**

```
chore: final cleanup for graph refactor
```
