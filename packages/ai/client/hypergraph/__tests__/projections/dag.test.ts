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

  test("spawn branch nodes are offset to the right", () => {
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
      { type: "text", id: "t1", runId: "r2", agentId: "a2", content: "Working" },
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
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        input: { task: "go" },
      },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t1", runId: "r2", agentId: "a2", content: "Sub" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        output: "done",
      },
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
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        input: {},
      },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
      {
        type: "tool_call",
        id: "tc2",
        runId: "r2",
        agentId: "a2",
        name: "agent",
        input: {},
      },
      { type: "harness_start", runId: "r3", agentId: "a3", parentId: "tc2" },
      { type: "text", id: "t1", runId: "r3", agentId: "a3", content: "Deep" },
      { type: "harness_end", runId: "r3", agentId: "a3" },
      {
        type: "tool_result",
        id: "tc2",
        runId: "r2",
        agentId: "a2",
        name: "agent",
        output: "ok",
      },
      { type: "harness_end", runId: "r2", agentId: "a2" },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        output: "ok",
      },
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

    for (const group of result.groups) {
      if (group.edgeType !== "message") continue;
      // Group box includes padding, so x/y may be negative
      expect(group.width).toBeGreaterThan(0);
      expect(group.height).toBeGreaterThan(0);
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
});
