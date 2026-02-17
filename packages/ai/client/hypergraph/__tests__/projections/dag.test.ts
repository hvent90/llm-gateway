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
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
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
