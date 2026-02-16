import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState, type GraphEvent } from "../../reducer";
import { projectForceGraph, type ForceNode } from "../../projections/force-graph";

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

  test("single completed run → block nodes with message hulls", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    // All nodes are blocks (not chunks)
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes.every((n) => n.kind === "block")).toBe(true);

    // Sequence links between blocks
    expect(result.links.length).toBeGreaterThanOrEqual(1);

    // NO block hulls — blocks are the atomic nodes now
    const blockHulls = result.hulls.filter((h) => (h.edgeType as string) === "block");
    expect(blockHulls.length).toBe(0);

    // Message hulls exist and contain block IDs
    const messageHulls = result.hulls.filter((h) => h.edgeType === "message");
    expect(messageHulls.length).toBeGreaterThanOrEqual(1);

    // Message hull nodeIds are block IDs (not chunk IDs)
    for (const hull of messageHulls) {
      for (const id of hull.nodeIds) {
        const node = g.nodes.get(id as any);
        expect(node?.kind).toBe("block");
      }
    }
  });

  test("block nodes include rendering metadata", () => {
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
      expect(node).toHaveProperty("blockType");
      expect(node).toHaveProperty("label");
      expect(node).toHaveProperty("color");
      expect(node).toHaveProperty("borderColor");
      expect(node).toHaveProperty("width");
      expect(node).toHaveProperty("height");
      expect(node.kind).toBe("block");
    }
  });

  test("block types are correctly assigned", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi there" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "tool_result", id: "tc1", runId: "r1", agentId: "a1", name: "bash", output: "file.txt" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    const types = result.nodes.map((n) => n.blockType);
    expect(types).toContain("user");
    expect(types).toContain("text");
    expect(types).toContain("tool_call");
  });

  test("node dimensions are clamped to reasonable bounds", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hi" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      {
        type: "text",
        id: "t1",
        runId: "r1",
        agentId: "a1",
        content: "A very long response text that should be truncated and capped at the max width value",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    for (const node of result.nodes) {
      expect(node.width).toBeGreaterThanOrEqual(80);
      expect(node.width).toBeLessThanOrEqual(200);
      expect(node.height).toBeGreaterThanOrEqual(30);
    }
  });

  test("color scheme matches block types", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Reply" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    const userNode = result.nodes.find((n) => n.blockType === "user");
    expect(userNode?.color).toBe("#0a3d1f");
    expect(userNode?.borderColor).toBe("#22c55e");

    const textNode = result.nodes.find((n) => n.blockType === "text");
    expect(textNode?.color).toBe("#1e3a5f");
    expect(textNode?.borderColor).toBe("#3b82f6");
  });

  test("hulls include label and padding (message level only)", () => {
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
      // All hulls should be message level
      expect(hull.level).toBe("message");
    }
  });

  test("spawn edges produce spawn links between block nodes", () => {
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

    // Both source and target should be block nodes
    for (const link of spawnLinks) {
      const sourceNode = result.nodes.find((n) => n.id === link.source);
      const targetNode = result.nodes.find((n) => n.id === link.target);
      expect(sourceNode).toBeDefined();
      expect(sourceNode?.kind).toBe("block");
      expect(targetNode).toBeDefined();
      expect(targetNode?.kind).toBe("block");
    }
  });

  test("message hull contains blocks from that message", () => {
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

    // Every nodeId in a message hull should be a block node that exists in nodes
    for (const hull of messageHulls) {
      for (const nodeId of hull.nodeIds) {
        const node = result.nodes.find((n) => n.id === nodeId);
        expect(node).toBeDefined();
        expect(node?.kind).toBe("block");
      }
    }
  });

  test("structural blocks get structural blockType", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    const structuralNodes = result.nodes.filter((n) => n.blockType === "structural");
    // harness_start and harness_end should be structural
    expect(structuralNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("sequence links connect adjacent blocks", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "bash", input: { cmd: "ls" } },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = projectForceGraph(g);

    const seqLinks = result.links.filter((l) => l.type === "sequence");
    expect(seqLinks.length).toBeGreaterThanOrEqual(1);

    // All sequence links should be between block nodes
    for (const link of seqLinks) {
      expect(result.nodes.find((n) => n.id === link.source)).toBeDefined();
      expect(result.nodes.find((n) => n.id === link.target)).toBeDefined();
    }
  });
});
