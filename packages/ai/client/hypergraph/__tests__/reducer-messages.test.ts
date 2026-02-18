import { describe, test, expect } from "bun:test";
import { createGraph, findEdges } from "../primitives";
import { reduceEvent, createReducerState } from "../reducer";
import { blocksOf } from "../queries";
import type { ConversationGraph } from "../types";

type GraphEvent = any;

function buildGraph(events: GraphEvent[]): ConversationGraph {
  let g = createGraph();
  let s = createReducerState();
  for (const e of events) [g, s] = reduceEvent(g, s, e);
  return g;
}

describe("Hypergraph Reducer — Message Boundaries", () => {
  test("harness_end creates a message node grouping all blocks in the run", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBe(1);
    // Message edge groups blocks
    const msgEdges = findEdges(g, { type: "message" });
    expect(msgEdges.length).toBe(1);
    // Should contain blocks (harness_start, text, harness_end blocks)
    expect(msgEdges[0]!.roles.part.length).toBeGreaterThanOrEqual(1);
  });

  test("user event creates its own message node", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" }]);
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBe(1);
  });

  test("text after tool_result triggers new message in same run", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Sure" },
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
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "Done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    // Should have multiple messages
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test("multi-turn conversation has message sequence edges", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "What is 2+2?" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      {
        type: "text",
        id: "t1",
        runId: "r1",
        agentId: "a1",
        parentId: "u1:user",
        content: "4",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
      { type: "user", runId: "u2", content: "And 3+3?" },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "u2:user" },
      {
        type: "text",
        id: "t2",
        runId: "r2",
        agentId: "a2",
        parentId: "u2:user",
        content: "6",
      },
      { type: "harness_end", runId: "r2", agentId: "a2" },
    ]);
    const messages = [...g.nodes.values()].filter((n) => n.kind === "message");
    expect(messages.length).toBe(4); // 2 user + 2 assistant
    // Should have sequence edges between messages
    const msgSeqs = findEdges(g, { type: "sequence" }).filter((e) => {
      const pred = g.nodes.get(e.roles.predecessor[0]!);
      return pred?.kind === "message";
    });
    expect(msgSeqs.length).toBeGreaterThanOrEqual(1);
  });
});
