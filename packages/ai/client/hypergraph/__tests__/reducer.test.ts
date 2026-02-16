import { describe, test, expect } from "bun:test";
import { createGraph, findEdges, getNode } from "../primitives";
import { reduceEvent, createReducerState } from "../reducer";
import { chunksOf, blockOf } from "../queries";
import type { ConversationGraph } from "../types";

type GraphEvent = any;

function buildGraph(events: GraphEvent[]): ConversationGraph {
  let g = createGraph();
  let s = createReducerState();
  for (const e of events) [g, s] = reduceEvent(g, s, e);
  return g;
}

describe("Hypergraph Reducer", () => {
  test("text event creates chunk node and block node", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
    ]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(1);
    expect(blocks.length).toBe(1);
    // Chunk stores the event
    if (chunks[0]!.kind === "chunk") {
      expect(chunks[0]!.content.type).toBe("text");
    }
    // Block edge links chunk to block
    const blockEdges = findEdges(g, { type: "block" });
    expect(blockEdges.length).toBe(1);
    expect(blockEdges[0]!.roles.part.length).toBe(1);
  });

  test("streaming text with same id extends block edge", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "world" },
    ]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(2);
    expect(blocks.length).toBe(1);
    // Block edge has both chunks
    const blockEdges = findEdges(g, { type: "block" });
    expect(blockEdges[0]!.roles.part.length).toBe(2);
  });

  test("different text ids create separate blocks", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "First" },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "Second" },
    ]);
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(blocks.length).toBe(2);
    // Sequence edge between blocks
    const seqEdges = findEdges(g, {
      type: "sequence",
      node: blocks[0]!.id,
      role: "predecessor",
    });
    expect(seqEdges.length).toBe(1);
  });

  test("reasoning then text creates separate blocks", () => {
    const g = buildGraph([
      { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "Hmm" },
      { type: "text", id: "t1", runId: "run1", agentId: "a1", content: "Answer" },
    ]);
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(blocks.length).toBe(2);
  });

  test("tool_call creates a chunk and block", () => {
    const g = buildGraph([
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
    ]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(1);
    expect(blocks.length).toBe(1);
  });

  test("tool_result with same id as tool_call creates a separate block", () => {
    const g = buildGraph([
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
    ]);
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(blocks.length).toBe(2);
  });

  test("chunk sequence edges follow event arrival order", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    expect(chunks.length).toBe(3);
    // Sequence edges connect them in order
    const seqEdges = findEdges(g, { type: "sequence" });
    const chunkSeqs = seqEdges.filter((e) => {
      const pred = e.roles.predecessor[0]!;
      const node = g.nodes.get(pred);
      return node?.kind === "chunk";
    });
    expect(chunkSeqs.length).toBeGreaterThanOrEqual(2);
  });

  test("parentId creates spawn edge", () => {
    const g = buildGraph([
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "agent",
        input: { task: "go" },
      },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
    ]);
    const spawnEdges = findEdges(g, { type: "spawn" });
    expect(spawnEdges.length).toBe(1);
    expect(spawnEdges[0]!.roles.trigger.length).toBe(1);
    expect(spawnEdges[0]!.roles.invocation.length).toBe(1);
  });

  test("connected event is ignored", () => {
    const g = buildGraph([{ type: "connected", sessionId: "s-1" }]);
    expect(g.nodes.size).toBe(0);
  });

  test("user event creates chunk and block", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" }]);
    const chunks = [...g.nodes.values()].filter((n) => n.kind === "chunk");
    const blocks = [...g.nodes.values()].filter((n) => n.kind === "block");
    expect(chunks.length).toBe(1);
    expect(blocks.length).toBe(1);
  });

  test("graph is immutable", () => {
    const g1 = createGraph();
    const s1 = createReducerState();
    const [g2] = reduceEvent(g1, s1, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Hi",
    });
    expect(g1.nodes.size).toBe(0);
    expect(g2.nodes.size).toBeGreaterThan(0);
  });
});
