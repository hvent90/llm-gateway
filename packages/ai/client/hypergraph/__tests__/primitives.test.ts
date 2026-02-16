import { describe, test, expect } from "bun:test";
import { createGraph, addNode, addEdge, extendEdge, getNode, findEdges } from "../primitives";
import type { ConversationNode, HyperEdge } from "../types";

describe("Graph Primitives", () => {
  test("createGraph returns empty graph", () => {
    const g = createGraph();
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
  });

  test("addNode inserts a node and returns its id", () => {
    const g = createGraph();
    const node: ConversationNode = {
      id: "c1",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "hi" } as any,
    };
    const g2 = addNode(g, node);
    expect(g2.nodes.size).toBe(1);
    expect(g2.nodes.get("c1")).toEqual(node);
    // Original unchanged
    expect(g.nodes.size).toBe(0);
  });

  test("addEdge creates a hyperedge", () => {
    let g = createGraph();
    g = addNode(g, { id: "a", kind: "block" });
    g = addNode(g, { id: "b", kind: "block" });
    g = addEdge(g, {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    });
    expect(g.edges.size).toBe(1);
    expect(g.edges.get("e1")!.type).toBe("sequence");
  });

  test("extendEdge appends node ids to a role participant list", () => {
    let g = createGraph();
    g = addNode(g, {
      id: "c1",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "a" } as any,
    });
    g = addNode(g, {
      id: "c2",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "b" } as any,
    });
    g = addNode(g, { id: "b1", kind: "block" });
    g = addEdge(g, {
      id: "e1",
      type: "block",
      roles: { part: ["c1"], whole: ["b1"] },
      properties: {},
    });
    g = extendEdge(g, "e1", "part", ["c2"]);
    const edge = g.edges.get("e1")!;
    if (edge.type === "block") {
      expect(edge.roles.part).toEqual(["c1", "c2"]);
    }
  });

  test("getNode retrieves a node by id", () => {
    let g = createGraph();
    g = addNode(g, { id: "m1", kind: "message" });
    expect(getNode(g, "m1")).toEqual({ id: "m1", kind: "message" });
    expect(getNode(g, "nonexistent")).toBeNull();
  });

  test("findEdges queries by type", () => {
    let g = createGraph();
    g = addEdge(g, {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "e2",
      type: "block",
      roles: { part: ["c1"], whole: ["b1"] },
      properties: {},
    });
    const seqEdges = findEdges(g, { type: "sequence" });
    expect(seqEdges.length).toBe(1);
    expect(seqEdges[0]!.id).toBe("e1");
  });

  test("findEdges queries by node participant", () => {
    let g = createGraph();
    g = addEdge(g, {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "e2",
      type: "block",
      roles: { part: ["a", "c"], whole: ["d"] },
      properties: {},
    });
    // Find all edges involving node "a"
    const edges = findEdges(g, { node: "a" });
    expect(edges.length).toBe(2);
  });

  test("findEdges queries by node and role", () => {
    let g = createGraph();
    g = addEdge(g, {
      id: "e1",
      type: "block",
      roles: { part: ["c1", "c2"], whole: ["b1"] },
      properties: {},
    });
    // c1 in part role
    const partEdges = findEdges(g, { node: "c1", role: "part" });
    expect(partEdges.length).toBe(1);
    // c1 NOT in whole role
    const wholeEdges = findEdges(g, { node: "c1", role: "whole" });
    expect(wholeEdges.length).toBe(0);
  });

  test("findEdges queries by type + node + role", () => {
    let g = createGraph();
    g = addEdge(g, {
      id: "e1",
      type: "block",
      roles: { part: ["c1"], whole: ["b1"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "e2",
      type: "message",
      roles: { part: ["b1"], whole: ["m1"] },
      properties: {},
    });
    // b1 is in "whole" of block edge AND "part" of message edge
    const blockWhole = findEdges(g, {
      type: "block",
      node: "b1",
      role: "whole",
    });
    expect(blockWhole.length).toBe(1);
    expect(blockWhole[0]!.id).toBe("e1");
    const messagePart = findEdges(g, {
      type: "message",
      node: "b1",
      role: "part",
    });
    expect(messagePart.length).toBe(1);
    expect(messagePart[0]!.id).toBe("e2");
  });

  test("graph is immutable — addNode does not mutate original", () => {
    const g1 = createGraph();
    const g2 = addNode(g1, { id: "x", kind: "block" });
    expect(g1.nodes.size).toBe(0);
    expect(g2.nodes.size).toBe(1);
  });

  test("graph is immutable — addEdge does not mutate original", () => {
    const g1 = createGraph();
    const g2 = addEdge(g1, {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    });
    expect(g1.edges.size).toBe(0);
    expect(g2.edges.size).toBe(1);
  });
});
