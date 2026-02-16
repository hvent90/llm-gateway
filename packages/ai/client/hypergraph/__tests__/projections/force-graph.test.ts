import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState, type GraphEvent } from "../../reducer";
import { defaultActive } from "../../walk";
import { projectForceGraph } from "../../projections/force-graph";
import { expand } from "../../operations";

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

    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    expect(result.nodes.every((n) => n.kind === "message")).toBe(true);
    expect(result.links.length).toBeGreaterThanOrEqual(1);
    expect(result.links.every((l) => l.type === "sequence")).toBe(true);
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
    const result = projectForceGraph(g, active);

    // Find a message node to expand
    const messageNodes = result.nodes.filter((n) => n.kind === "message");

    // Use expand to get block-level active set
    const expandedActive = expand(g, active, messageNodes[0]!.id as any);
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
    const allNodes = new Set([...g.nodes.keys()]);
    const result = projectForceGraph(g, allNodes);
    expect(result.links.some((l) => l.type === "spawn")).toBe(true);
  });
});
