import { describe, test, expect } from "bun:test";
import type {
  NodeId,
  EdgeId,
  ConversationNode,
  HyperEdge,
  SequenceEdge,
  BlockEdge,
  MessageEdge,
  SummaryEdge,
  SpawnEdge,
  ConversationGraph,
  EdgeType,
  EdgeRole,
} from "../types";

describe("Hypergraph Types", () => {
  test("ConversationNode discriminates on kind", () => {
    const chunk: ConversationNode = {
      id: "c1",
      kind: "chunk",
      content: {
        type: "text",
        id: "t1",
        runId: "r1",
        content: "hello",
      } as any,
    };
    const block: ConversationNode = { id: "b1", kind: "block" };
    const message: ConversationNode = { id: "m1", kind: "message" };

    expect(chunk.kind).toBe("chunk");
    expect(block.kind).toBe("block");
    expect(message.kind).toBe("message");

    // Only chunk has content
    if (chunk.kind === "chunk") {
      expect(chunk.content).toBeDefined();
    }
  });

  test("HyperEdge discriminates on type with typed roles", () => {
    const seq: HyperEdge = {
      id: "e1",
      type: "sequence",
      roles: { predecessor: ["a"], successor: ["b"] },
      properties: {},
    };
    const blk: HyperEdge = {
      id: "e2",
      type: "block",
      roles: { part: ["c1", "c2"], whole: ["b1"] },
      properties: {},
    };
    const msg: HyperEdge = {
      id: "e3",
      type: "message",
      roles: { part: ["b1", "b2"], whole: ["m1"] },
      properties: {},
    };
    const sum: HyperEdge = {
      id: "e4",
      type: "summary",
      roles: { source: ["m1", "m2"], result: ["s1"] },
      properties: { model: "claude" },
    };
    const spn: HyperEdge = {
      id: "e5",
      type: "spawn",
      roles: { trigger: ["tc1"], invocation: ["hs1"] },
      properties: {},
    };

    expect(seq.type).toBe("sequence");
    expect(blk.type).toBe("block");
    expect(msg.type).toBe("message");
    expect(sum.type).toBe("summary");
    expect(spn.type).toBe("spawn");

    // Type narrowing works
    if (seq.type === "sequence") {
      expect(seq.roles.predecessor).toEqual(["a"]);
      expect(seq.roles.successor).toEqual(["b"]);
    }
    if (sum.type === "summary") {
      expect(sum.roles.source).toEqual(["m1", "m2"]);
      expect(sum.properties.model).toBe("claude");
    }
  });

  test("ConversationGraph holds nodes and edges", () => {
    const graph: ConversationGraph = {
      nodes: new Map(),
      edges: new Map(),
    };
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
  });
});
