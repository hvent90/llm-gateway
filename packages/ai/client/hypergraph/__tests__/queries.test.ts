import { describe, test, expect } from "bun:test";
import { createGraph, addNode, addEdge } from "../primitives";
import { chunksOf, blocksOf, sourcesOf, blockOf, messageOf, summariesOf } from "../queries";

describe("Relationship Queries", () => {
  test("chunksOf returns part nodes from block edge", () => {
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
      roles: { part: ["c1", "c2"], whole: ["b1"] },
      properties: {},
    });
    expect(chunksOf(g, "b1")).toEqual(["c1", "c2"]);
  });

  test("blocksOf returns part nodes from message edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "b1", kind: "block" });
    g = addNode(g, { id: "b2", kind: "block" });
    g = addNode(g, { id: "m1", kind: "message" });
    g = addEdge(g, {
      id: "e1",
      type: "message",
      roles: { part: ["b1", "b2"], whole: ["m1"] },
      properties: {},
    });
    expect(blocksOf(g, "m1")).toEqual(["b1", "b2"]);
  });

  test("sourcesOf returns source nodes from summary edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "m1", kind: "message" });
    g = addNode(g, { id: "m2", kind: "message" });
    g = addNode(g, { id: "s1", kind: "message" });
    g = addEdge(g, {
      id: "e1",
      type: "summary",
      roles: { source: ["m1", "m2"], result: ["s1"] },
      properties: {},
    });
    expect(sourcesOf(g, "s1")).toEqual(["m1", "m2"]);
  });

  test("blockOf returns the whole from block edge", () => {
    let g = createGraph();
    g = addNode(g, {
      id: "c1",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "a" } as any,
    });
    g = addNode(g, { id: "b1", kind: "block" });
    g = addEdge(g, {
      id: "e1",
      type: "block",
      roles: { part: ["c1"], whole: ["b1"] },
      properties: {},
    });
    expect(blockOf(g, "c1")).toBe("b1");
  });

  test("messageOf returns the whole from message edge", () => {
    let g = createGraph();
    g = addNode(g, { id: "b1", kind: "block" });
    g = addNode(g, { id: "m1", kind: "message" });
    g = addEdge(g, {
      id: "e1",
      type: "message",
      roles: { part: ["b1"], whole: ["m1"] },
      properties: {},
    });
    expect(messageOf(g, "b1")).toBe("m1");
  });

  test("summariesOf returns result nodes from summary edges", () => {
    let g = createGraph();
    g = addNode(g, { id: "m1", kind: "message" });
    g = addNode(g, { id: "s1", kind: "message" });
    g = addNode(g, { id: "s2", kind: "message" });
    g = addEdge(g, {
      id: "e1",
      type: "summary",
      roles: { source: ["m1"], result: ["s1"] },
      properties: {},
    });
    g = addEdge(g, {
      id: "e2",
      type: "summary",
      roles: { source: ["m1"], result: ["s2"] },
      properties: {},
    });
    expect(summariesOf(g, "m1")).toEqual(["s1", "s2"]);
  });

  test("upward queries return null when no edge exists", () => {
    let g = createGraph();
    g = addNode(g, {
      id: "c1",
      kind: "chunk",
      content: { type: "text", id: "t1", runId: "r1", content: "a" } as any,
    });
    expect(blockOf(g, "c1")).toBeNull();
    expect(messageOf(g, "c1")).toBeNull();
    expect(summariesOf(g, "c1")).toEqual([]);
  });
});
