import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState, type GraphEvent } from "../../reducer";
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
    const result = projectForceGraph(g);
    expect(result.nodes).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.hulls).toEqual([]);
  });

  test("single completed run → chunk nodes with block and message hulls", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    // All nodes are chunks
    expect(result.nodes.length).toBeGreaterThanOrEqual(3);
    expect(result.nodes.every((n) => n.kind === "chunk")).toBe(true);

    // Sequence links between chunks
    expect(result.links.length).toBeGreaterThanOrEqual(1);

    // Block hulls exist
    const blockHulls = result.hulls.filter((h) => h.edgeType === "block");
    expect(blockHulls.length).toBeGreaterThanOrEqual(1);

    // Message hulls exist
    const messageHulls = result.hulls.filter((h) => h.edgeType === "message");
    expect(messageHulls.length).toBeGreaterThanOrEqual(1);

    // Message hull nodeIds are chunk IDs
    for (const hull of messageHulls) {
      for (const id of hull.nodeIds) {
        const node = g.nodes.get(id as any);
        expect(node?.kind).toBe("chunk");
      }
    }
  });

  test("chunk nodes include rendering metadata", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    for (const node of result.nodes) {
      expect(node).toHaveProperty("id");
      expect(node).toHaveProperty("kind");
      expect(node).toHaveProperty("label");
      expect(node).toHaveProperty("color");
      expect(node).toHaveProperty("size");
      expect(node.kind).toBe("chunk");
    }
  });

  test("hulls include label and padding", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: " world" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    for (const hull of result.hulls) {
      expect(hull).toHaveProperty("label");
      expect(hull).toHaveProperty("padding");
      expect(typeof hull.label).toBe("string");
      expect(hull.padding).toBeGreaterThan(0);
    }

    const blockHulls = result.hulls.filter((h) => h.level === "block");
    const messageHulls = result.hulls.filter((h) => h.level === "message");
    if (blockHulls.length > 0 && messageHulls.length > 0) {
      expect(blockHulls[0]!.padding).toBeLessThan(messageHulls[0]!.padding);
    }
  });

  test("spawn edges produce spawn links between chunks", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "agent", input: { task: "go" } },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t1", runId: "r2", agentId: "a2", content: "Done" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "agent", output: "done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    const spawnLinks = result.links.filter((l) => l.type === "spawn");
    expect(spawnLinks.length).toBeGreaterThanOrEqual(1);

    // Both source and target should be chunk nodes
    for (const link of spawnLinks) {
      const sourceNode = g.nodes.get(link.source as any);
      const targetNode = g.nodes.get(link.target as any);
      expect(sourceNode?.kind).toBe("chunk");
      expect(targetNode?.kind).toBe("chunk");
    }
  });

  test("message hull contains chunks from all blocks in that message", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "bash", output: "file.txt" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    const messageHulls = result.hulls.filter((h) => h.edgeType === "message");
    expect(messageHulls.length).toBeGreaterThanOrEqual(1);

    // Every nodeId in a message hull should be a chunk that exists in nodes
    for (const hull of messageHulls) {
      for (const nodeId of hull.nodeIds) {
        expect(result.nodes.find((n) => n.id === nodeId)).toBeDefined();
      }
    }
  });
});
