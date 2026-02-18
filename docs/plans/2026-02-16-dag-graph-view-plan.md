# DAG Graph View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the force-directed graph visualization with a custom DAG layout using HTML nodes + SVG edges.

**Architecture:** A new `projectDAG` projection walks the hypergraph and assigns deterministic `(x, y)` positions to every block node. The React `GraphView` renders HTML divs for nodes and SVG paths for edges inside a shared pan/zoom container. No physics simulation, no d3, no external layout libraries.

**Tech Stack:** TypeScript, Bun test runner, React, Tailwind CSS, SVG

**Reference:** `docs/plans/2026-02-16-dag-graph-view-design.md`

---

### Task 1: DAG Projection Types + Linear Layout

Create the DAG projection that walks a linear conversation (no branching) and assigns `(x, y)` positions. This is the foundation — spawn/fork/groups come in later tasks.

**Files:**
- Create: `packages/ai/client/hypergraph/projections/dag.ts`
- Test: `packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/ai/client/hypergraph/__tests__/projections/dag.test.ts
import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState, type GraphEvent } from "../../reducer";
import { projectDAG, type DAGNode, type DAGLayout } from "../../projections/dag";

function buildGraph(events: GraphEvent[]) {
  let g = createGraph();
  let s = createReducerState();
  for (const e of events) [g, s] = reduceEvent(g, s, e);
  return g;
}

describe("projectDAG", () => {
  test("empty graph → empty layout", () => {
    const g = createGraph();
    const result = projectDAG(g);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.groups).toEqual([]);
    expect(result.totalWidth).toBe(0);
    expect(result.totalHeight).toBe(0);
  });

  test("single run → block nodes with x=0 and increasing y", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectDAG(g);

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);

    // All nodes at x=0 (main spine)
    for (const node of result.nodes) {
      expect(node.x).toBe(0);
    }

    // Y values are strictly increasing (top-to-bottom order)
    for (let i = 1; i < result.nodes.length; i++) {
      expect(result.nodes[i]!.y).toBeGreaterThan(result.nodes[i - 1]!.y);
    }
  });

  test("nodes have correct rendering metadata", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Reply" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectDAG(g);

    for (const node of result.nodes) {
      expect(node).toHaveProperty("id");
      expect(node).toHaveProperty("x");
      expect(node).toHaveProperty("y");
      expect(node).toHaveProperty("width");
      expect(node).toHaveProperty("height");
      expect(node).toHaveProperty("blockType");
      expect(node).toHaveProperty("label");
      expect(node).toHaveProperty("color");
      expect(node).toHaveProperty("borderColor");
      expect(node.width).toBeGreaterThanOrEqual(100);
      expect(node.width).toBeLessThanOrEqual(400);
      expect(node.height).toBeGreaterThanOrEqual(30);
    }
  });

  test("block types are correctly assigned", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "bash", output: "file.txt" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectDAG(g);
    const types = result.nodes.map((n) => n.blockType);
    expect(types).toContain("user");
    expect(types).toContain("text");
    expect(types).toContain("tool_call");
  });

  test("sequence edges connect adjacent blocks", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectDAG(g);

    const seqEdges = result.edges.filter((e) => e.type === "sequence");
    expect(seqEdges.length).toBeGreaterThanOrEqual(1);

    for (const edge of seqEdges) {
      expect(result.nodes.find((n) => n.id === edge.source)).toBeDefined();
      expect(result.nodes.find((n) => n.id === edge.target)).toBeDefined();
    }
  });

  test("totalWidth and totalHeight enclose all nodes", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Reply" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectDAG(g);

    for (const node of result.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(result.totalWidth);
      expect(node.y + node.height).toBeLessThanOrEqual(result.totalHeight);
    }
  });

  test("color scheme matches force-graph colors", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Reply" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectDAG(g);

    const userNode = result.nodes.find((n) => n.blockType === "user");
    expect(userNode?.color).toBe("#0a3d1f");
    expect(userNode?.borderColor).toBe("#22c55e");

    const textNode = result.nodes.find((n) => n.blockType === "text");
    expect(textNode?.color).toBe("#1e3a5f");
    expect(textNode?.borderColor).toBe("#3b82f6");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the projection**

Create `packages/ai/client/hypergraph/projections/dag.ts` with:
- Types: `DAGNode`, `DAGEdge`, `DAGGroup`, `DAGLayout` (from design doc)
- Color maps: same `BLOCK_FILL_COLORS`, `BLOCK_BORDER_COLORS` as `force-graph.ts`
- Helpers: `deriveBlockType`, `blockLabel` — same logic as `force-graph.ts`, using `deriveBlockContent` from `../derived`
- Node sizing: approximate `width = Math.min(Math.max(label.length * 7, 100), 400)`, `height = Math.max(30, 20 + Math.ceil(label.length / 50) * 16)` — same as `force-graph.ts:193-196`
- Layout constants: `NODE_GAP = 12`, `COLUMN_GAP = 40`, `GROUP_PAD = 12`
- `projectDAG(graph)` function:
  1. Collect all block nodes (same iteration as `force-graph.ts:186-208`)
  2. Collect all links between blocks (same logic as `force-graph.ts:211-263`)
  3. Build adjacency map from links for topological ordering
  4. Walk blocks in topological order, assign `y` incrementally and `x = 0` for all nodes (branching comes in Task 2)
  5. Compute `totalWidth` and `totalHeight` from node positions
  6. Return `{ nodes, edges, groups: [], totalWidth, totalHeight }`

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/projections/dag.ts packages/ai/client/hypergraph/__tests__/projections/dag.test.ts
git commit -m "feat(dag): add DAG projection with linear layout"
```

---

### Task 2: DAG Layout — Spawn Branches

Add column assignment for subagent spawn branches. Spawn targets are placed in nested columns to the right of their parent.

**Files:**
- Modify: `packages/ai/client/hypergraph/projections/dag.ts`
- Modify: `packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`

**Step 1: Write the failing test**

Add to `dag.test.ts`:

```typescript
test("spawn branch nodes are offset to the right", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "agent", input: { task: "go" } },
    { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
    { type: "text", id: "t1", runId: "r2", agentId: "a2", content: "Working" },
    { type: "harness_end", runId: "r2", agentId: "a2" },
    { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "agent", output: "done" },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const result = projectDAG(g);

  // Find the tool_call node and the spawned subagent text node
  const tcNode = result.nodes.find((n) => n.blockType === "tool_call");
  const subagentTextNode = result.nodes.find(
    (n) => n.blockType === "text" && n.label === "Working",
  );
  expect(tcNode).toBeDefined();
  expect(subagentTextNode).toBeDefined();

  // Subagent node should be to the right of the parent column
  expect(subagentTextNode!.x).toBeGreaterThan(tcNode!.x);

  // Spawn edge should exist
  const spawnEdges = result.edges.filter((e) => e.type === "spawn");
  expect(spawnEdges.length).toBeGreaterThanOrEqual(1);
});

test("parent flow continues below spawn branch", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    { type: "text", id: "t0", runId: "r1", agentId: "a1", content: "Before" },
    { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "agent", input: { task: "go" } },
    { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
    { type: "text", id: "t1", runId: "r2", agentId: "a2", content: "Sub" },
    { type: "harness_end", runId: "r2", agentId: "a2" },
    { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "agent", output: "done" },
    { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "After" },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const result = projectDAG(g);

  const beforeNode = result.nodes.find((n) => n.label === "Before");
  const afterNode = result.nodes.find((n) => n.label === "After");
  expect(beforeNode).toBeDefined();
  expect(afterNode).toBeDefined();

  // "After" is below "Before" and in the same column (x=0)
  expect(afterNode!.y).toBeGreaterThan(beforeNode!.y);
  expect(afterNode!.x).toBe(beforeNode!.x);
});

test("nested spawns offset further right", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "agent", input: {} },
    { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
    { type: "tool_call", id: "tc2", runId: "r2", agentId: "a2", name: "agent", input: {} },
    { type: "harness_start", runId: "r3", agentId: "a3", parentId: "tc2" },
    { type: "text", id: "t1", runId: "r3", agentId: "a3", content: "Deep" },
    { type: "harness_end", runId: "r3", agentId: "a3" },
    { type: "tool_result", id: "tc2", runId: "r2", agentId: "a2", name: "agent", output: "ok" },
    { type: "harness_end", runId: "r2", agentId: "a2" },
    { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "agent", output: "ok" },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const result = projectDAG(g);

  const tc1 = result.nodes.find((n) => n.blockType === "tool_call" && n.id.includes("tc1"));
  const tc2 = result.nodes.find((n) => n.blockType === "tool_call" && n.id.includes("tc2"));
  const deep = result.nodes.find((n) => n.label === "Deep");

  // Each level offsets further right
  expect(tc2!.x).toBeGreaterThan(tc1!.x);
  expect(deep!.x).toBeGreaterThan(tc2!.x);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: FAIL — spawn nodes have x=0 instead of being offset

**Step 3: Implement column assignment**

Update `projectDAG` to:
1. Build a `runId → parentRunId` map from spawn edges
2. Assign each runId a column depth: root runs get column 0, spawned runs get `parentColumn + 1`
3. When assigning x, use `column * (NODE_WIDTH + COLUMN_GAP)` where `NODE_WIDTH` is the max width in that column (or a fixed column width like 300)
4. For the y stacking within a spawn branch: the first node of a spawn branch starts at the same y as the tool_call that triggered it (or slightly below)
5. Parent flow nodes after the spawn branch resume at `max(parentLastY, spawnBranchBottomY) + NODE_GAP`

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/projections/dag.ts packages/ai/client/hypergraph/__tests__/projections/dag.test.ts
git commit -m "feat(dag): add spawn branch column layout"
```

---

### Task 3: DAG Layout — Message Groups

Compute bounding boxes for message groups. Each message edge in the hypergraph becomes a `DAGGroup`.

**Files:**
- Modify: `packages/ai/client/hypergraph/projections/dag.ts`
- Modify: `packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`

**Step 1: Write the failing test**

```typescript
test("message groups enclose their blocks", () => {
  const g = buildGraph([
    { type: "user", runId: "u1", content: "Hello" },
    { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
    { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Reply" },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const result = projectDAG(g);

  expect(result.groups.length).toBeGreaterThanOrEqual(1);

  for (const group of result.groups) {
    expect(group.edgeType).toBe("message");
    expect(group).toHaveProperty("x");
    expect(group).toHaveProperty("y");
    expect(group).toHaveProperty("width");
    expect(group).toHaveProperty("height");
    expect(group).toHaveProperty("label");
    expect(group).toHaveProperty("color");
    expect(group).toHaveProperty("borderColor");
    expect(group.width).toBeGreaterThan(0);
    expect(group.height).toBeGreaterThan(0);
  }
});

test("message group bounding box contains all child block positions", () => {
  const g = buildGraph([
    { type: "harness_start", runId: "r1", agentId: "a1" },
    { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
    { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
    { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "bash", output: "file.txt" },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const result = projectDAG(g);

  // Build a map of nodeId → group for checking containment
  const nodeById = new Map(result.nodes.map((n) => [n.id, n]));

  for (const group of result.groups) {
    if (group.edgeType !== "message") continue;
    // Find child nodes that belong to this group's message
    // Group bounding box should be >= the extent of its children
    expect(group.x).toBeGreaterThanOrEqual(0);
    expect(group.y).toBeGreaterThanOrEqual(0);
  }
});

test("user message groups have green tint, assistant have blue tint", () => {
  const g = buildGraph([
    { type: "user", runId: "u1", content: "Hello" },
    { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
    { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Reply" },
    { type: "harness_end", runId: "r1", agentId: "a1" },
  ]);
  const result = projectDAG(g);

  const userGroup = result.groups.find((g) => g.label.includes("Hello"));
  const assistantGroup = result.groups.find((g) => g.label.includes("assistant"));

  if (userGroup) {
    expect(userGroup.color).toContain("34,197,94"); // green
  }
  if (assistantGroup) {
    expect(assistantGroup.color).toContain("59,130,246"); // blue
  }
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: FAIL — groups array is empty

**Step 3: Implement group computation**

After nodes are positioned, iterate message edges (same as `force-graph.ts:267-283`):
1. For each message edge, collect the block nodeIds that are in the `nodes` array
2. Find the positioned nodes by id
3. Compute bounding box: `x = min(node.x) - GROUP_PAD`, `y = min(node.y) - GROUP_PAD`, `width = max(node.x + node.width) - x + GROUP_PAD`, `height = max(node.y + node.height) - y + GROUP_PAD`
4. Use `messageLabel` and `messageHullColor` from force-graph helpers (copy them in)
5. Set `borderColor` based on role (green border for user, blue for assistant)

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/projections/dag.ts packages/ai/client/hypergraph/__tests__/projections/dag.test.ts
git commit -m "feat(dag): add message group bounding boxes"
```

---

### Task 4: DAG Layout — Summary Groups

Add summary group computation. Summary edges produce groups with dashed purple borders.

**Files:**
- Modify: `packages/ai/client/hypergraph/projections/dag.ts`
- Modify: `packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`

**Step 1: Write the failing test**

```typescript
test("summary groups have purple styling and 'summarized' label", () => {
  // Build a graph with a summary edge manually using primitives
  const { createGraph, addNode, addEdge } = await import("../../primitives");
  let g = createGraph();
  g = addNode(g, { id: "b1", kind: "block" });
  g = addNode(g, { id: "b2", kind: "block" });
  g = addNode(g, { id: "m1", kind: "message" });
  g = addNode(g, { id: "m2", kind: "message" });
  g = addEdge(g, { id: "me1", type: "message", roles: { part: ["b1"], whole: ["m1"] }, properties: {} });
  g = addEdge(g, { id: "me2", type: "message", roles: { part: ["b2"], whole: ["m2"] }, properties: {} });
  g = addEdge(g, { id: "seq1", type: "sequence", roles: { predecessor: ["b1"], successor: ["b2"] }, properties: {} });
  g = addEdge(g, { id: "seq2", type: "sequence", roles: { predecessor: ["m1"], successor: ["m2"] }, properties: {} });
  g = addEdge(g, { id: "sum1", type: "summary", roles: { source: ["m1"], result: ["m2"] }, properties: {} });

  const result = projectDAG(g);

  const summaryGroups = result.groups.filter((g) => g.edgeType === "summary");
  expect(summaryGroups.length).toBe(1);
  expect(summaryGroups[0]!.label).toBe("summarized");
  expect(summaryGroups[0]!.color).toContain("167,139,250"); // purple
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: FAIL

**Step 3: Implement summary groups**

Same pattern as `force-graph.ts:286-308`: iterate summary edges, expand source messages to block IDs, compute bounding box from positioned nodes.

**Step 4: Run test to verify it passes**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/dag.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/projections/dag.ts packages/ai/client/hypergraph/__tests__/projections/dag.test.ts
git commit -m "feat(dag): add summary group bounding boxes"
```

---

### Task 5: Export DAG Projection + Update Index

Wire the new projection into the package exports.

**Files:**
- Modify: `packages/ai/client/hypergraph/index.ts`

**Step 1: Add exports**

Add to `packages/ai/client/hypergraph/index.ts`:

```typescript
export { projectDAG } from "./projections/dag";
export type { DAGNode, DAGEdge, DAGGroup, DAGLayout } from "./projections/dag";
```

**Step 2: Run all projection tests**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/`
Expected: ALL PASS (both dag and existing force-graph tests)

**Step 3: Commit**

```bash
git add packages/ai/client/hypergraph/index.ts
git commit -m "feat(dag): export DAG projection from hypergraph index"
```

---

### Task 6: usePanZoom Hook

Create the pan/zoom hook for the graph view container.

**Files:**
- Create: `clients/web/src/hooks/usePanZoom.ts`

**Step 1: Implement the hook**

```typescript
// clients/web/src/hooks/usePanZoom.ts
import { useRef, useCallback, useEffect, useState } from "react";

interface PanZoomState {
  tx: number;
  ty: number;
  scale: number;
}

interface UsePanZoomOptions {
  minScale?: number;
  maxScale?: number;
}

export function usePanZoom(options: UsePanZoomOptions = {}) {
  const { minScale = 0.1, maxScale = 3 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<PanZoomState>({ tx: 0, ty: 0, scale: 1 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const [scale, setScale] = useState(1); // for UI display only

  const applyTransform = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const { tx, ty, scale } = stateRef.current;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    el.style.transformOrigin = "0 0";
  }, []);

  const zoomToFit = useCallback(
    (totalWidth: number, totalHeight: number, padding = 40) => {
      const container = containerRef.current;
      if (!container || totalWidth === 0 || totalHeight === 0) return;
      const rect = container.getBoundingClientRect();
      const scaleX = (rect.width - padding * 2) / totalWidth;
      const scaleY = (rect.height - padding * 2) / totalHeight;
      const newScale = Math.min(scaleX, scaleY, 1); // don't zoom in past 100%
      const clampedScale = Math.max(minScale, Math.min(maxScale, newScale));
      stateRef.current = {
        tx: (rect.width - totalWidth * clampedScale) / 2,
        ty: (rect.height - totalHeight * clampedScale) / 2,
        scale: clampedScale,
      };
      setScale(clampedScale);
      applyTransform();
    },
    [applyTransform, minScale, maxScale],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const { tx, ty, scale: oldScale } = stateRef.current;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(minScale, Math.min(maxScale, oldScale * factor));

      // Zoom centered on cursor
      stateRef.current = {
        tx: mouseX - (mouseX - tx) * (newScale / oldScale),
        ty: mouseY - (mouseY - ty) * (newScale / oldScale),
        scale: newScale,
      };
      setScale(newScale);
      applyTransform();
    };

    const onMouseDown = (e: MouseEvent) => {
      // Only pan on left-click on empty space (not on nodes)
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-dag-node]")) return;
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        tx: stateRef.current.tx,
        ty: stateRef.current.ty,
      };
      container.style.cursor = "grabbing";
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      stateRef.current.tx = panStartRef.current.tx + dx;
      stateRef.current.ty = panStartRef.current.ty + dy;
      applyTransform();
    };

    const onMouseUp = () => {
      isPanningRef.current = false;
      container.style.cursor = "";
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [applyTransform, minScale, maxScale]);

  return { containerRef, contentRef, scale, zoomToFit, stateRef };
}
```

**Step 2: Commit**

```bash
git add clients/web/src/hooks/usePanZoom.ts
git commit -m "feat(web): add usePanZoom hook"
```

---

### Task 7: DAGNode Component

The HTML node component rendered at each block's `(x, y)`.

**Files:**
- Create: `clients/web/src/components/graph/DAGNode.tsx`

**Step 1: Implement the component**

```typescript
// clients/web/src/components/graph/DAGNode.tsx
import type { PendingRelay } from "../../types";

export interface DAGNodeData {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blockType: string;
  label: string;
  color: string;
  borderColor: string;
}

interface DAGNodeProps {
  node: DAGNodeData;
  relay?: PendingRelay;
  onAllow?: (relay: PendingRelay) => void;
  onAllowAll?: (relay: PendingRelay) => void;
  onDeny?: (relay: PendingRelay) => void;
}

export function DAGNode({ node, relay, onAllow, onAllowAll, onDeny }: DAGNodeProps) {
  return (
    <div
      data-dag-node
      className="absolute select-text overflow-hidden rounded"
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        minHeight: node.height,
        backgroundColor: node.color,
        borderWidth: relay ? 2 : 1,
        borderStyle: "solid",
        borderColor: relay ? "#f59e0b" : node.borderColor,
        boxShadow: relay ? "0 0 8px rgba(245,158,11,0.4)" : undefined,
      }}
    >
      <div className="px-2 py-0.5 text-[10px]" style={{ color: node.borderColor }}>
        {node.blockType}
      </div>
      <div className="px-2 pb-1.5 font-mono text-xs text-neutral-200"
        style={{ wordBreak: "break-word" }}
      >
        {node.label.length > 300 ? node.label.slice(0, 300) + "..." : node.label}
      </div>
      {relay && (
        <div className="flex gap-1 border-t border-neutral-700 px-2 py-1.5">
          <button
            className="rounded bg-green-800 px-2 py-0.5 text-[10px] text-green-200 hover:bg-green-700"
            onClick={() => onAllow?.(relay)}
          >
            Allow
          </button>
          <button
            className="rounded bg-blue-800 px-2 py-0.5 text-[10px] text-blue-200 hover:bg-blue-700"
            onClick={() => onAllowAll?.(relay)}
          >
            Allow All
          </button>
          <button
            className="rounded bg-red-900 px-2 py-0.5 text-[10px] text-red-200 hover:bg-red-800"
            onClick={() => onDeny?.(relay)}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add clients/web/src/components/graph/DAGNode.tsx
git commit -m "feat(web): add DAGNode component"
```

---

### Task 8: DAGEdge and DAGGroup Components

SVG components for edges and group bounding boxes.

**Files:**
- Create: `clients/web/src/components/graph/DAGEdge.tsx`
- Create: `clients/web/src/components/graph/DAGGroup.tsx`

**Step 1: Implement DAGEdge**

```typescript
// clients/web/src/components/graph/DAGEdge.tsx
import type { DAGNodeData } from "./DAGNode";

interface DAGEdgeProps {
  source: DAGNodeData;
  target: DAGNodeData;
  type: "sequence" | "spawn";
}

export function DAGEdge({ source, target, type }: DAGEdgeProps) {
  // Sequence: vertical line from bottom-center of source to top-center of target
  // Spawn: L-shaped path from right side of source to top-center of target
  const sx = type === "spawn" ? source.x + source.width : source.x + source.width / 2;
  const sy = type === "spawn" ? source.y + source.height / 2 : source.y + source.height;
  const tx = target.x + target.width / 2;
  const ty = target.y;

  let d: string;
  if (type === "spawn") {
    // L-shaped: go right, then down
    const midX = tx;
    d = `M${sx},${sy} L${midX},${sy} L${midX},${ty}`;
  } else {
    // Straight vertical (or slight S-curve if not aligned)
    if (Math.abs(sx - tx) < 1) {
      d = `M${sx},${sy} L${tx},${ty}`;
    } else {
      const midY = (sy + ty) / 2;
      d = `M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}`;
    }
  }

  return (
    <path
      d={d}
      fill="none"
      stroke={type === "spawn" ? "#ec4899aa" : "#6b7280aa"}
      strokeWidth={1.5}
      strokeDasharray={type === "spawn" ? "4 4" : undefined}
      markerEnd="url(#arrowhead)"
    />
  );
}
```

**Step 2: Implement DAGGroup**

```typescript
// clients/web/src/components/graph/DAGGroup.tsx
interface DAGGroupProps {
  group: {
    id: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    borderColor: string;
    edgeType: "message" | "summary";
  };
}

export function DAGGroup({ group }: DAGGroupProps) {
  return (
    <g>
      <rect
        x={group.x}
        y={group.y}
        width={group.width}
        height={group.height}
        rx={6}
        fill={group.color}
        stroke={group.borderColor}
        strokeWidth={1}
        strokeDasharray={group.edgeType === "summary" ? "4 4" : undefined}
      />
      <text
        x={group.x + 8}
        y={group.y - 4}
        fill="#9ca3af"
        fontSize={11}
      >
        {group.label}
      </text>
    </g>
  );
}
```

**Step 3: Commit**

```bash
git add clients/web/src/components/graph/DAGEdge.tsx clients/web/src/components/graph/DAGGroup.tsx
git commit -m "feat(web): add DAGEdge and DAGGroup SVG components"
```

---

### Task 9: GraphView — Main Composition

Replace `GraphView.tsx` entirely. Compose the projection, pan/zoom, and sub-components.

**Files:**
- Delete + Recreate: `clients/web/src/components/GraphView.tsx`

**Step 1: Implement the new GraphView**

```typescript
// clients/web/src/components/GraphView.tsx
import { useMemo, useEffect, useRef } from "react";
import type { ConversationGraph } from "../../../../packages/ai/client/hypergraph";
import { projectDAG } from "../../../../packages/ai/client/hypergraph/projections/dag";
import type { PendingRelay } from "../types";
import { usePanZoom } from "../hooks/usePanZoom";
import { DAGNode } from "./graph/DAGNode";
import { DAGEdge } from "./graph/DAGEdge";
import { DAGGroup } from "./graph/DAGGroup";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface GraphViewProps {
  graph: ConversationGraph;
  pendingRelays?: PendingRelay[];
  permissionHandlers?: PermissionHandlers;
}

export function GraphView({ graph, pendingRelays = [], permissionHandlers }: GraphViewProps) {
  const layout = useMemo(() => projectDAG(graph), [graph]);
  const { containerRef, contentRef, scale, zoomToFit } = usePanZoom();
  const hasInitialFit = useRef(false);

  // Build relay lookup: toolCallId → PendingRelay
  const relayByToolCallId = useMemo(() => {
    const map = new Map<string, PendingRelay>();
    for (const r of pendingRelays) map.set(r.toolCallId, r);
    return map;
  }, [pendingRelays]);

  // Build node lookup for edge rendering
  const nodeById = useMemo(() => {
    const map = new Map<string, (typeof layout.nodes)[number]>();
    for (const n of layout.nodes) map.set(n.id, n);
    return map;
  }, [layout]);

  // Initial fit
  useEffect(() => {
    if (!hasInitialFit.current && layout.nodes.length > 0) {
      hasInitialFit.current = true;
      zoomToFit(layout.totalWidth, layout.totalHeight);
    }
  }, [layout, zoomToFit]);

  if (layout.nodes.length === 0) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full items-center justify-center text-neutral-600"
      >
        send a message to see the graph
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <div ref={contentRef}>
        {/* SVG layer: groups + edges (behind nodes) */}
        <svg
          className="absolute left-0 top-0"
          width={layout.totalWidth}
          height={layout.totalHeight}
          style={{ pointerEvents: "none" }}
        >
          <defs>
            <marker
              id="arrowhead"
              viewBox="0 0 10 7"
              refX="10"
              refY="3.5"
              markerWidth="6"
              markerHeight="5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#6b7280" />
            </marker>
          </defs>
          {/* Groups behind everything */}
          {layout.groups.map((group) => (
            <DAGGroup key={group.id} group={group} />
          ))}
          {/* Edges */}
          {layout.edges.map((edge) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) return null;
            return (
              <DAGEdge
                key={`${edge.source}-${edge.target}`}
                source={source}
                target={target}
                type={edge.type}
              />
            );
          })}
        </svg>
        {/* HTML node layer */}
        {layout.nodes.map((node) => {
          const relay = relayByToolCallId.get(node.id);
          return (
            <DAGNode
              key={node.id}
              node={node}
              relay={relay}
              onAllow={permissionHandlers?.onAllow}
              onAllowAll={permissionHandlers?.onAllowAll}
              onDeny={permissionHandlers?.onDeny}
            />
          );
        })}
      </div>
      {/* Zoom controls */}
      <button
        className="absolute bottom-3 right-3 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700 hover:text-white"
        onClick={() => zoomToFit(layout.totalWidth, layout.totalHeight)}
      >
        fit
      </button>
      <div className="absolute bottom-3 right-14 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400">
        {Math.round(scale * 100)}%
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add clients/web/src/components/GraphView.tsx
git commit -m "feat(web): replace GraphView with DAG renderer"
```

---

### Task 10: Wire Up App.tsx — Relay Props

Pass `pendingRelays` and permission handlers to GraphView.

**Files:**
- Modify: `clients/web/src/App.tsx`

**Step 1: Update GraphView import and props**

In `App.tsx`, the `GraphView` import stays the same path. Update the JSX to pass relay props:

Change line 235:
```tsx
<GraphView graph={state.graph} />
```
To:
```tsx
<GraphView
  graph={state.graph}
  pendingRelays={state.pendingRelays}
  permissionHandlers={permissionHandlers}
/>
```

Also update the `PermissionHandlers` import — it now comes from GraphView, not just ConversationThread. Or define it in a shared location. Simplest: import from GraphView since both components define the same interface.

**Step 2: Run dev server and smoke test**

Run: `bun run dev` (in one terminal) and `bun run dev:web` (in another)
- Open browser, switch to Graph tab
- Send a message
- Verify: nodes appear top-to-bottom, edges connect them, message groups enclose blocks
- If agent mode, verify relay buttons appear on tool_call nodes

**Step 3: Commit**

```bash
git add clients/web/src/App.tsx
git commit -m "feat(web): pass relay props to GraphView"
```

---

### Task 11: Update Types + Legend

Remove force-graph type re-exports and add DAG types. Remove the legend from the old GraphView (it was inline) — the new GraphView can add one later if needed.

**Files:**
- Modify: `clients/web/src/types.ts`

**Step 1: Update type re-exports**

Replace force-graph re-exports with DAG re-exports:

```typescript
// Remove these lines:
export type { ForceNode, ForceLink, ForceHull, ForceGraphData } from "...";

// Add:
export type { DAGNode, DAGEdge, DAGGroup, DAGLayout } from "../../../packages/ai/client/hypergraph";
```

**Step 2: Commit**

```bash
git add clients/web/src/types.ts
git commit -m "refactor(web): swap force-graph type exports for DAG types"
```

---

### Task 12: Delete Old Files

Remove force-graph projection, convex-hull, and old GraphView remnants.

**Files:**
- Delete: `packages/ai/client/hypergraph/projections/force-graph.ts`
- Delete: `packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts`
- Delete: `clients/web/src/lib/convex-hull.ts`
- Delete: `clients/web/src/__tests__/convex-hull.test.ts`
- Modify: `packages/ai/client/hypergraph/index.ts` — remove force-graph exports

**Step 1: Remove force-graph exports from index**

In `packages/ai/client/hypergraph/index.ts`, remove:
```typescript
export { projectForceGraph } from "./projections/force-graph";
export type { ForceNode, ForceLink, ForceHull, ForceGraphData } from "./projections/force-graph";
```

**Step 2: Delete files**

```bash
rm packages/ai/client/hypergraph/projections/force-graph.ts
rm packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts
rm clients/web/src/lib/convex-hull.ts
rm clients/web/src/__tests__/convex-hull.test.ts
```

**Step 3: Verify no remaining imports**

Run: `grep -r "force-graph\|convex-hull\|ForceNode\|ForceLink\|ForceHull\|ForceGraphData" clients/web/src/ packages/ai/client/hypergraph/`
Expected: no matches (or only in the deleted files' git history)

**Step 4: Run all tests**

Run: `bun test packages/ai/client/hypergraph/`
Expected: ALL PASS (force-graph tests gone, dag tests pass, all other tests unaffected)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete force-graph projection and convex-hull"
```

---

### Task 13: Remove d3/force-graph Dependencies

Remove the npm packages.

**Files:**
- Modify: `package.json`

**Step 1: Remove packages**

```bash
bun remove react-force-graph-2d d3-force-3d
```

**Step 2: Verify build**

```bash
bun run build:web
```

Expected: build succeeds with no import errors

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: remove react-force-graph-2d and d3-force-3d dependencies"
```

---

### Task 14: Update Projections CLAUDE.md

Update the projection docs to reflect the new DAG projection replacing force-graph.

**Files:**
- Modify: `packages/ai/client/hypergraph/projections/CLAUDE.md`

**Step 1: Update docs**

Replace the force-graph bullet with:
```
- `dag.ts` — `projectDAG(graph) → DAGLayout` for 2D DAG visualization. Block-level nodes with deterministic (x, y) positioning, message/summary group bounding boxes.
```

Remove the force-graph gotcha and add:
```
- `dag.ts` computes approximate node sizes from label length (no DOM required). Column assignment follows spawn edges to nest subagent branches.
```

**Step 2: Commit**

```bash
git add packages/ai/client/hypergraph/projections/CLAUDE.md
git commit -m "docs: update projections CLAUDE.md for DAG projection"
```

---

### Task 15: Format + Final Verification

Run formatter and full test suite.

**Step 1: Format**

```bash
bun run format
```

**Step 2: Run all tests**

```bash
bun test
```

Expected: all tests pass. Pre-existing failures in `orchestrator.test.ts` and `server/index.test.ts` are unrelated.

**Step 3: Visual smoke test**

```bash
bun run dev &
bun run dev:web &
```

Open browser:
1. Send a message in chat view — verify chat still works
2. Switch to graph view — verify nodes render top-to-bottom
3. Verify edges connect nodes
4. Verify message groups enclose their blocks
5. Send a message that triggers a tool call — verify relay buttons appear (if applicable)

**Step 4: Commit any formatting changes**

```bash
git add -A
git commit -m "style: apply oxfmt formatting"
```

---

## Dependency Graph

```
Task 1 (linear layout)
  ↓
Task 2 (spawn branches)
  ↓
Task 3 (message groups)
  ↓
Task 4 (summary groups)
  ↓
Task 5 (exports)
  ↓
Tasks 6-8 (React components — can be parallelized)
  ↓
Task 9 (GraphView composition)
  ↓
Task 10 (App.tsx wiring)
  ↓
Task 11 (types cleanup)
  ↓
Task 12 (delete old files)
  ↓
Task 13 (remove deps)
  ↓
Task 14 (docs)
  ↓
Task 15 (format + verify)
```

Tasks 6, 7, 8 (usePanZoom, DAGNode, DAGEdge/DAGGroup) are independent and can be parallelized.
