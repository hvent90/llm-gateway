# Hypergraph Force-Graph Visualization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a force-directed graph view to the web client that visualizes the conversation hypergraph with convex hull groupings, expand/collapse, hover details, and live streaming updates.

**Architecture:** A `projectForceGraph` projection transforms `ConversationGraph` + active set into `{ nodes, links, hulls }` for `react-force-graph-2d`. Convex hulls are drawn in a canvas post-render callback. Expand/collapse uses the existing SDK operations. The view is toggled alongside the existing chat view in `App.tsx`.

**Tech Stack:** react-force-graph-2d, existing hypergraph SDK (expand, collapse, defaultActive, findEdges, queries)

---

### Task 1: Install react-force-graph-2d

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `bun add react-force-graph-2d`

**Step 2: Verify installation**

Run: `bun run dev:web`
Expected: Vite dev server starts without errors

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add react-force-graph-2d dependency"
```

---

### Task 2: projectForceGraph projection

**Files:**
- Create: `packages/ai/client/hypergraph/projections/force-graph.ts`
- Test: `packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts`

**Context:** This projection transforms a `ConversationGraph` + `active: Set<NodeId>` into the data format that `react-force-graph-2d` expects. It's analogous to `projectThread` but outputs graph visualization data instead of a flat thread.

The projection needs to:
1. Collect visible nodes (those in the active set, plus their children if expanded)
2. Collect visible links (sequence and spawn edges between visible nodes)
3. Collect hull definitions (block/message/summary edges where members are visible)

**Docs to check:**
- `packages/ai/client/hypergraph/types.ts` — `ConversationNode`, `HyperEdge` types
- `packages/ai/client/hypergraph/queries.ts` — `chunksOf`, `blocksOf` for traversal
- `packages/ai/client/hypergraph/walk.ts` — `defaultActive` for initial visible set

**Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState, type GraphEvent } from "../../reducer";
import { defaultActive } from "../../walk";
import { projectForceGraph } from "../../projections/force-graph";

function buildGraph(events: GraphEvent[]) {
  let g = createGraph();
  let s = createReducerState();
  for (const e of events) [g, s] = reduceEvent(g, s, e);
  return g;
}

describe("projectForceGraph", () => {
  test("empty graph → empty result", () => {
    const g = createGraph();
    const result = projectForceGraph(g, new Set());
    expect(result.nodes).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.hulls).toEqual([]);
  });

  test("single completed run → message nodes + sequence links", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const active = defaultActive(g);
    const result = projectForceGraph(g, active);

    // Default active = message-level nodes
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    expect(result.nodes.every((n) => n.kind === "message")).toBe(true);

    // Sequence links between messages
    expect(result.links.length).toBeGreaterThanOrEqual(1);
    expect(result.links.every((l) => l.type === "sequence")).toBe(true);

    // No hulls at message level (hulls appear when expanded)
    expect(result.hulls).toEqual([]);
  });

  test("nodes include metadata for rendering", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const active = defaultActive(g);
    const result = projectForceGraph(g, active);

    for (const node of result.nodes) {
      expect(node).toHaveProperty("id");
      expect(node).toHaveProperty("kind");
      expect(node).toHaveProperty("label");
      expect(node).toHaveProperty("color");
      expect(node).toHaveProperty("size");
    }
  });

  test("expanded message → block nodes + message hull", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        output: "file.txt",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const active = defaultActive(g);

    // Expand the first message
    const messageNodes = result.nodes.filter((n) => n.kind === "message");

    // Use expand from operations to get block-level active set
    // (tested via integration — expand is already tested in operations.test.ts)
    const { expand } = await import("../../operations");
    const expandedActive = expand(g, active, messageNodes[0]!.id);
    const expanded = projectForceGraph(g, expandedActive);

    // Should now have block-level nodes
    expect(expanded.nodes.some((n) => n.kind === "block")).toBe(true);

    // Should have a message hull grouping the blocks
    expect(expanded.hulls.length).toBeGreaterThanOrEqual(1);
    expect(expanded.hulls[0]!.edgeType).toBe("message");
  });

  test("spawn edges produce spawn links", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        input: { task: "go" },
      },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t1", runId: "r2", agentId: "a2", content: "Done" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        output: "done",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    // Use fullHistoryActive or expand enough to see spawn edges
    const allNodes = new Set([...g.nodes.keys()]);
    const result = projectForceGraph(g, allNodes);
    expect(result.links.some((l) => l.type === "spawn")).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts`
Expected: FAIL — module not found

**Step 3: Write the projection**

```typescript
import type {
  ConversationGraph,
  ConversationNode,
  NodeId,
  HyperEdge,
  ChunkEvent,
} from "../types";
import { findEdges, getNode } from "../primitives";
import { chunksOf, blocksOf } from "../queries";
import { deriveBlockContent } from "../derived";

// --- Public types ---

export interface ForceNode {
  id: string;
  kind: "chunk" | "block" | "message";
  label: string;
  color: string;
  size: number;
}

export interface ForceLink {
  source: string;
  target: string;
  type: "sequence" | "spawn";
  dashed: boolean;
}

export interface ForceHull {
  edgeId: string;
  edgeType: "block" | "message" | "summary";
  nodeIds: string[];
  color: string;
}

export interface ForceGraphData {
  nodes: ForceNode[];
  links: ForceLink[];
  hulls: ForceHull[];
}

// --- Colors ---

const CHUNK_COLORS: Record<string, string> = {
  text: "#3b82f6",        // blue
  reasoning: "#8b5cf6",   // violet
  tool_call: "#f97316",   // orange
  tool_result: "#f59e0b", // amber
  user: "#22c55e",        // green
  error: "#ef4444",       // red
  harness_start: "#6b7280", // gray
  harness_end: "#6b7280",
  relay: "#ec4899",       // pink
  usage: "#6b7280",
  tool_progress: "#f59e0b",
};

const BLOCK_COLORS: Record<string, string> = {
  text: "#3b82f680",
  tool_call: "#f9731680",
  user: "#22c55e80",
  error: "#ef444480",
  default: "#6b728080",
};

const MESSAGE_COLOR = "#ffffff20";
const SUMMARY_COLOR = "#a78bfa40";

// --- Helpers ---

function chunkColor(event: ChunkEvent): string {
  return CHUNK_COLORS[event.type] ?? "#6b7280";
}

function chunkLabel(event: ChunkEvent): string {
  switch (event.type) {
    case "text":
      return event.content.slice(0, 30);
    case "user":
      return typeof event.content === "string" ? event.content.slice(0, 30) : "[media]";
    case "tool_call":
      return event.name;
    case "tool_result":
      return `${event.name} result`;
    case "error":
      return event.message;
    case "reasoning":
      return "thinking...";
    default:
      return event.type;
  }
}

function blockLabel(graph: ConversationGraph, blockId: NodeId): string {
  const content = deriveBlockContent(graph, blockId);
  if (!content) return "structural";
  switch (content.kind) {
    case "text":
      return content.text.slice(0, 30);
    case "tool_call":
      return content.name;
    case "user":
      return typeof content.content === "string" ? content.content.slice(0, 30) : "[media]";
    case "error":
      return content.message;
    default:
      return content.kind;
  }
}

function blockColor(graph: ConversationGraph, blockId: NodeId): string {
  const chunks = chunksOf(graph, blockId);
  if (chunks.length === 0) return BLOCK_COLORS.default!;
  const first = getNode(graph, chunks[0]!);
  if (!first || first.kind !== "chunk") return BLOCK_COLORS.default!;
  return BLOCK_COLORS[first.content.type] ?? BLOCK_COLORS.default!;
}

function messageLabel(graph: ConversationGraph, messageId: NodeId): string {
  const blocks = blocksOf(graph, messageId);
  // Check if it's a user message
  for (const blockId of blocks) {
    const content = deriveBlockContent(graph, blockId);
    if (content?.kind === "user") {
      return typeof content.content === "string" ? content.content.slice(0, 30) : "[user]";
    }
  }
  return `assistant (${blocks.length} blocks)`;
}

// --- Main projection ---

export function projectForceGraph(
  graph: ConversationGraph,
  active: Set<NodeId>,
): ForceGraphData {
  const nodes: ForceNode[] = [];
  const links: ForceLink[] = [];
  const hulls: ForceHull[] = [];
  const visibleIds = new Set<string>();

  // 1. Collect visible nodes
  for (const nodeId of active) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    visibleIds.add(nodeId);

    switch (node.kind) {
      case "chunk":
        nodes.push({
          id: nodeId,
          kind: "chunk",
          label: chunkLabel(node.content),
          color: chunkColor(node.content),
          size: 4,
        });
        break;
      case "block":
        nodes.push({
          id: nodeId,
          kind: "block",
          label: blockLabel(graph, nodeId),
          color: blockColor(graph, nodeId),
          size: 8,
        });
        break;
      case "message":
        nodes.push({
          id: nodeId,
          kind: "message",
          label: messageLabel(graph, nodeId),
          color: "#e5e7eb",
          size: 14,
        });
        break;
    }
  }

  // 2. Collect visible links (sequence + spawn edges between visible nodes)
  for (const edge of graph.edges.values()) {
    if (edge.type === "sequence") {
      for (const pred of edge.roles.predecessor) {
        for (const succ of edge.roles.successor) {
          if (visibleIds.has(pred) && visibleIds.has(succ)) {
            links.push({
              source: pred,
              target: succ,
              type: "sequence",
              dashed: false,
            });
          }
        }
      }
    } else if (edge.type === "spawn") {
      for (const trigger of edge.roles.trigger) {
        for (const inv of edge.roles.invocation) {
          if (visibleIds.has(trigger) && visibleIds.has(inv)) {
            links.push({
              source: trigger,
              target: inv,
              type: "spawn",
              dashed: true,
            });
          }
        }
      }
    }
  }

  // 3. Collect hulls (containment edges where members are visible)
  for (const edge of graph.edges.values()) {
    if (edge.type === "block") {
      const visibleParts = edge.roles.part.filter((id) => visibleIds.has(id));
      if (visibleParts.length >= 2) {
        hulls.push({
          edgeId: edge.id,
          edgeType: "block",
          nodeIds: visibleParts,
          color: BLOCK_COLORS.default!,
        });
      }
    } else if (edge.type === "message") {
      const visibleParts = edge.roles.part.filter((id) => visibleIds.has(id));
      if (visibleParts.length >= 2) {
        hulls.push({
          edgeId: edge.id,
          edgeType: "message",
          nodeIds: visibleParts,
          color: MESSAGE_COLOR,
        });
      }
    } else if (edge.type === "summary") {
      const visibleSources = edge.roles.source.filter((id) => visibleIds.has(id));
      if (visibleSources.length >= 2) {
        hulls.push({
          edgeId: edge.id,
          edgeType: "summary",
          nodeIds: visibleSources,
          color: SUMMARY_COLOR,
        });
      }
    }
  }

  return { nodes, links, hulls };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/ai/client/hypergraph/projections/force-graph.ts \
       packages/ai/client/hypergraph/__tests__/projections/force-graph.test.ts
git commit -m "feat(hypergraph): add force-graph projection"
```

---

### Task 3: Convex hull geometry utility

**Files:**
- Create: `clients/web/src/lib/convex-hull.ts`
- Test: `clients/web/src/__tests__/convex-hull.test.ts`

**Context:** The force-graph canvas post-render callback needs to draw convex hulls around groups of nodes. This utility computes the hull polygon from a set of 2D points and provides a padded, rounded path for drawing.

**Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from "bun:test";
import { convexHull, paddedHullPath } from "../lib/convex-hull";

describe("convexHull", () => {
  test("empty points → empty hull", () => {
    expect(convexHull([])).toEqual([]);
  });

  test("single point → single point hull", () => {
    expect(convexHull([{ x: 5, y: 5 }])).toEqual([{ x: 5, y: 5 }]);
  });

  test("two points → both points", () => {
    const result = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(result.length).toBe(2);
  });

  test("square → 4 corner points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior point — excluded
    ];
    const result = convexHull(points);
    expect(result.length).toBe(4);
  });
});

describe("paddedHullPath", () => {
  test("returns a Path2D for canvas drawing", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const path = paddedHullPath(points, 5);
    expect(path).toBeInstanceOf(Path2D);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test clients/web/src/__tests__/convex-hull.test.ts`
Expected: FAIL — module not found

**Step 3: Implement convex hull (Graham scan)**

```typescript
export interface Point {
  x: number;
  y: number;
}

/**
 * Compute the convex hull of a set of 2D points using Graham scan.
 * Returns points in counter-clockwise order.
 */
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return [...points];

  // Find lowest y (leftmost tiebreak)
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  const pivot = sorted[0]!;

  // Sort by polar angle from pivot
  const rest = sorted.slice(1).sort((a, b) => {
    const angleA = Math.atan2(a.y - pivot.y, a.x - pivot.x);
    const angleB = Math.atan2(b.y - pivot.y, b.x - pivot.x);
    if (angleA !== angleB) return angleA - angleB;
    const distA = (a.x - pivot.x) ** 2 + (a.y - pivot.y) ** 2;
    const distB = (b.x - pivot.x) ** 2 + (b.y - pivot.y) ** 2;
    return distA - distB;
  });

  const stack: Point[] = [pivot];
  for (const p of rest) {
    while (stack.length >= 2) {
      const a = stack[stack.length - 2]!;
      const b = stack[stack.length - 1]!;
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cross <= 0) stack.pop();
      else break;
    }
    stack.push(p);
  }

  return stack;
}

/**
 * Create a padded, rounded Path2D from hull points for canvas drawing.
 */
export function paddedHullPath(points: Point[], padding: number): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;

  if (points.length === 1) {
    const p = points[0]!;
    path.arc(p.x, p.y, padding, 0, Math.PI * 2);
    return path;
  }

  if (points.length === 2) {
    // Capsule shape between two points
    const [a, b] = points as [Point, Point];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = (-dy / len) * padding;
    const ny = (dx / len) * padding;
    const angle = Math.atan2(dy, dx);

    path.moveTo(a.x + nx, a.y + ny);
    path.lineTo(b.x + nx, b.y + ny);
    path.arc(b.x, b.y, padding, angle - Math.PI / 2, angle + Math.PI / 2);
    path.lineTo(a.x - nx, a.y - ny);
    path.arc(a.x, a.y, padding, angle + Math.PI / 2, angle + Math.PI * 1.5);
    path.closePath();
    return path;
  }

  // Offset each edge outward by padding, then connect with arcs at corners
  const hull = convexHull(points);
  const n = hull.length;

  for (let i = 0; i < n; i++) {
    const curr = hull[i]!;
    const next = hull[(i + 1) % n]!;
    const prev = hull[(i - 1 + n) % n]!;

    // Direction from curr to next
    const dx1 = next.x - curr.x;
    const dy1 = next.y - curr.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

    // Outward normal (left of direction = outward for CCW hull)
    const nx1 = (-dy1 / len1) * padding;
    const ny1 = (dx1 / len1) * padding;

    // Angle for arc at this corner
    const angleIn = Math.atan2(curr.y - prev.y, curr.x - prev.x) - Math.PI / 2;
    const angleOut = Math.atan2(dy1, dx1) - Math.PI / 2;

    if (i === 0) {
      path.moveTo(curr.x + nx1, curr.y + ny1);
    } else {
      path.arc(curr.x, curr.y, padding, angleIn, angleOut);
    }

    path.lineTo(next.x + nx1, next.y + ny1);
  }

  // Close with final arc
  const first = hull[0]!;
  const last = hull[n - 1]!;
  const dx = first.x - last.x;
  const dy = first.y - last.y;
  const angleIn = Math.atan2(dy, dx) - Math.PI / 2;
  const dxFirst = hull[1]!.x - first.x;
  const dyFirst = hull[1]!.y - first.y;
  const angleOut = Math.atan2(dyFirst, dxFirst) - Math.PI / 2;
  path.arc(first.x, first.y, padding, angleIn, angleOut);
  path.closePath();

  return path;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test clients/web/src/__tests__/convex-hull.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add clients/web/src/lib/convex-hull.ts clients/web/src/__tests__/convex-hull.test.ts
git commit -m "feat(web): add convex hull geometry utility"
```

---

### Task 4: GraphView component

**Files:**
- Create: `clients/web/src/components/GraphView.tsx`

**Context:** This is the main React component that renders the force-directed graph. It wraps `react-force-graph-2d` with custom node rendering, hull drawing, hover tooltips, and click-to-expand/collapse.

**Docs to check:**
- `react-force-graph-2d` README for API: `graphData`, `nodeCanvasObject`, `onRenderFramePost`, `onNodeClick`, `onNodeHover`, `cooldownTicks`
- `packages/ai/client/hypergraph/operations.ts` — `expand`, `collapse` signatures

**Step 1: Create the component**

```tsx
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ConversationGraph, NodeId } from "../../../../packages/ai/client/hypergraph";
import {
  defaultActive,
  expand,
  collapse,
  findEdges,
  blocksOf,
  chunksOf,
} from "../../../../packages/ai/client/hypergraph";
import {
  projectForceGraph,
  type ForceNode,
  type ForceHull,
} from "../../../../packages/ai/client/hypergraph/projections/force-graph";
import { convexHull, paddedHullPath } from "../lib/convex-hull";

interface GraphViewProps {
  graph: ConversationGraph;
}

export function GraphView({ graph }: GraphViewProps) {
  const [active, setActive] = useState<Set<NodeId>>(() => defaultActive(graph));
  const [hoveredNode, setHoveredNode] = useState<ForceNode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset active set when graph changes substantially (new messages)
  const messageCount = useMemo(
    () => [...graph.nodes.values()].filter((n) => n.kind === "message").length,
    [graph],
  );
  useEffect(() => {
    setActive(defaultActive(graph));
  }, [messageCount]);

  const data = useMemo(() => projectForceGraph(graph, active), [graph, active]);

  const handleNodeClick = useCallback(
    (node: ForceNode) => {
      if (node.kind === "message" || node.kind === "block") {
        setActive((prev) => expand(graph, prev, node.id as NodeId));
      } else {
        // Chunk click — try to collapse back to block
        const blockEdges = findEdges(graph, {
          type: "block",
          node: node.id as NodeId,
          role: "part",
        });
        if (blockEdges.length > 0) {
          const parts = blockEdges[0]!.roles.part;
          setActive((prev) => collapse(graph, prev, parts));
        }
      }
    },
    [graph],
  );

  const handleNodeHover = useCallback((node: ForceNode | null) => {
    setHoveredNode(node);
  }, []);

  const drawNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const forceNode = node as ForceNode & { x: number; y: number };
      const size = forceNode.size / globalScale;

      ctx.beginPath();
      ctx.arc(forceNode.x, forceNode.y, size, 0, Math.PI * 2);
      ctx.fillStyle = forceNode.color;
      ctx.fill();

      // Border for hovered node
      if (hoveredNode?.id === forceNode.id) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      // Label at sufficient zoom
      if (globalScale > 2) {
        ctx.fillStyle = "#e5e7eb";
        ctx.font = `${10 / globalScale}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(forceNode.label, forceNode.x, forceNode.y + size + 12 / globalScale);
      }
    },
    [hoveredNode],
  );

  const drawHulls = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      // Lookup current node positions from the force simulation data
      const nodePositions = new Map<string, { x: number; y: number }>();
      for (const node of data.nodes as Array<ForceNode & { x?: number; y?: number }>) {
        if (node.x !== undefined && node.y !== undefined) {
          nodePositions.set(node.id, { x: node.x, y: node.y });
        }
      }

      for (const hull of data.hulls) {
        const points = hull.nodeIds
          .map((id) => nodePositions.get(id))
          .filter((p): p is { x: number; y: number } => p !== undefined);

        if (points.length < 2) continue;

        const padding = 20 / globalScale;
        const path = paddedHullPath(points, padding);

        ctx.fillStyle = hull.color;
        ctx.fill(path);

        if (hull.edgeType === "summary") {
          ctx.setLineDash([4 / globalScale, 4 / globalScale]);
          ctx.strokeStyle = "#a78bfa";
          ctx.lineWidth = 1 / globalScale;
          ctx.stroke(path);
          ctx.setLineDash([]);
        }
      }
    },
    [data],
  );

  const linkColor = useCallback((link: any) => {
    return link.type === "spawn" ? "#ec489966" : "#6b728066";
  }, []);

  const linkDashArray = useCallback((link: any) => {
    return link.dashed ? [4, 4] : undefined;
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ForceGraph2D
        graphData={{ nodes: data.nodes as any[], links: data.links as any[] }}
        nodeCanvasObject={drawNode}
        onRenderFramePost={drawHulls}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        linkColor={linkColor}
        linkLineDash={linkDashArray}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        backgroundColor="transparent"
        cooldownTicks={50}
        nodeId="id"
        nodeRelSize={1}
      />
      {hoveredNode && (
        <div className="pointer-events-none absolute left-4 top-4 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
          <div className="font-mono text-neutral-500">{hoveredNode.id}</div>
          <div className="mt-1 font-bold">{hoveredNode.kind}</div>
          <div className="mt-1">{hoveredNode.label}</div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Verify it compiles**

Run: `bun run dev:web`
Expected: No compilation errors (component not mounted yet)

**Step 3: Commit**

```bash
git add clients/web/src/components/GraphView.tsx
git commit -m "feat(web): add GraphView component with force-graph rendering"
```

---

### Task 5: View toggle in App.tsx

**Files:**
- Modify: `clients/web/src/App.tsx`

**Context:** Add a Chat/Graph toggle to the header. Both views receive the same `state.graph`. Conditionally render `ConversationThread` or `GraphView`.

**Step 1: Add the toggle and conditional rendering**

Changes to `App.tsx`:

1. Add state: `const [view, setView] = useState<"chat" | "graph">("chat");`

2. Import `GraphView`:
   ```tsx
   import { GraphView } from "./components/GraphView";
   ```

3. Add toggle buttons in the header (after the `<h1>`):
   ```tsx
   <div className="flex gap-1 rounded bg-neutral-800 p-0.5 text-sm">
     <button
       className={`rounded px-2 py-0.5 ${view === "chat" ? "bg-neutral-600 text-white" : "text-neutral-400"}`}
       onClick={() => setView("chat")}
     >
       Chat
     </button>
     <button
       className={`rounded px-2 py-0.5 ${view === "graph" ? "bg-neutral-600 text-white" : "text-neutral-400"}`}
       onClick={() => setView("graph")}
     >
       Graph
     </button>
   </div>
   ```

4. Replace the `<main>` content with conditional rendering:
   ```tsx
   <main className="flex flex-1 flex-col-reverse overflow-y-auto p-3 sm:p-4">
     {view === "chat" ? (
       <div>
         <ConversationThread
           graph={state.graph}
           pendingRelays={state.pendingRelays}
           permissionHandlers={permissionHandlers}
         />
         {streamError && (
           <div className="mt-4 border border-neutral-700 p-3 text-sm text-red-400">
             error: {streamError}
           </div>
         )}
       </div>
     ) : (
       <GraphView graph={state.graph} />
     )}
   </main>
   ```

**Step 2: Manual test**

Run: `bun run dev:web`

1. Open browser to http://localhost:5173
2. Verify Chat/Graph toggle appears in header
3. Click "Graph" — should show empty force graph canvas
4. Switch back to "Chat" — should show normal chat
5. Send a message in Chat, switch to Graph — should see nodes appear

**Step 3: Commit**

```bash
git add clients/web/src/App.tsx
git commit -m "feat(web): add Chat/Graph view toggle"
```

---

### Task 6: Export projection from barrel + add types

**Files:**
- Modify: `packages/ai/client/hypergraph/index.ts`
- Modify: `clients/web/src/types.ts`

**Step 1: Export from barrel**

Add to `packages/ai/client/hypergraph/index.ts`:

```typescript
export { projectForceGraph } from "./projections/force-graph";
export type { ForceNode, ForceLink, ForceHull, ForceGraphData } from "./projections/force-graph";
```

**Step 2: Re-export from web types**

Add to `clients/web/src/types.ts`:

```typescript
export type {
  ForceNode,
  ForceLink,
  ForceHull,
  ForceGraphData,
} from "../../../packages/ai/client/hypergraph";
```

**Step 3: Run type check**

Run: `bunx tsc --noEmit 2>&1 | grep hypergraph`
Expected: No new errors

**Step 4: Commit**

```bash
git add packages/ai/client/hypergraph/index.ts clients/web/src/types.ts
git commit -m "feat(hypergraph): export force-graph projection types"
```

---

### Task 7: End-to-end manual test and polish

**Files:**
- Possibly modify: `clients/web/src/components/GraphView.tsx` (tweaks)

**Step 1: Start dev server and backend**

Run:
```bash
bun run dev       # starts both server and web
```

**Step 2: Test the full flow**

1. Open http://localhost:5173
2. Send "Hello" in Chat view
3. Switch to Graph view — verify:
   - Message-level nodes appear (2: user + assistant)
   - Sequence arrow between them
   - Nodes settle via force simulation
4. Click a message node — verify:
   - It expands into block-level nodes
   - A convex hull appears around the blocks
   - Sequence edges between blocks visible
5. Click a block node — verify:
   - It expands into chunk-level nodes
   - A block hull appears around the chunks
6. Click a chunk — verify:
   - Collapses back to block level
7. Hover nodes — verify:
   - Tooltip shows node kind, ID, label
8. Send another message while in Graph view — verify:
   - New nodes appear and the simulation adjusts smoothly

**Step 3: Fix any issues found during testing**

Common things to adjust:
- Force strength / charge parameters for good spacing
- Hull padding values
- Node sizes at different zoom levels
- Link arrow positioning

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(web): polish graph view rendering"
```
