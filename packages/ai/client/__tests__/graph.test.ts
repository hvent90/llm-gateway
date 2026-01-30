import { describe, test, expect } from "bun:test";
import { createInitialGraph, reduceGraphEvent } from "../graph";
import type { Node } from "../types";

describe("Graph Reducer", () => {
  test("creates a node for a text event", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Hello",
    });
    expect(g.nodes.size).toBe(1);
    const node = [...g.nodes.values()][0]!;
    expect(node.kind).toBe("text");
    expect(node.runId).toBe("r1");
    if (node.kind === "text") expect(node.content).toBe("Hello");
  });

  test("creates sequential edges within the same runId", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "A",
    });
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t2",
      runId: "r1",
      agentId: "a1",
      content: "B",
    });
    expect(g.edges.get("t1")).toEqual(["t2"]);
  });

  test("does not create edges between different runIds (without parentId)", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "A",
    });
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t2",
      runId: "r2",
      agentId: "a2",
      content: "B",
    });
    expect(g.edges.get("t1") ?? []).toEqual([]);
  });

  test("creates cross-run edge via parentId", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "tool_call",
      id: "tc-1",
      runId: "r1",
      agentId: "a1",
      name: "search",
      input: "auth",
    });
    g = reduceGraphEvent(g, {
      type: "harness_start",
      runId: "r2",
      agentId: "sub",
      parentId: "tc-1",
    });
    const targets = g.edges.get("tc-1") ?? [];
    expect(targets).toContain("r2:start");
  });

  test("tool_call node stores eventId", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "tool_call",
      id: "tc-1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    const node = g.nodes.get("tc-1")!;
    expect(node.kind).toBe("tool_call");
    if (node.kind === "tool_call") expect(node.eventId).toBe("tc-1");
  });

  test("tool_result node stores eventId and gets unique node id", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "tool_call",
      id: "tc-1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    g = reduceGraphEvent(g, {
      type: "tool_result",
      id: "tc-1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      output: "files",
    });
    expect(g.nodes.has("tc-1")).toBe(true);
    expect(g.nodes.has("tc-1:result")).toBe(true);
    const trNode = g.nodes.get("tc-1:result")!;
    if (trNode.kind === "tool_result") expect(trNode.eventId).toBe("tc-1");
  });

  test("harness_start/end get deterministic node ids", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "harness_start",
      runId: "r1",
      agentId: "a1",
    });
    g = reduceGraphEvent(g, {
      type: "harness_end",
      runId: "r1",
      agentId: "a1",
    });
    expect(g.nodes.has("r1:start")).toBe(true);
    expect(g.nodes.has("r1:end")).toBe(true);
  });

  test("skips connected events", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, { type: "connected", sessionId: "s-1" });
    expect(g.nodes.size).toBe(0);
  });

  test("user events create user nodes", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "user" as any,
      runId: "u1",
      content: "Hello",
    });
    const node = g.nodes.get("u1")!;
    expect(node.kind).toBe("user");
    if (node.kind === "user") expect(node.content).toBe("Hello");
  });

  test("subagent scenario: tool_call has edges to both result and spawn", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Let me search.",
    });
    g = reduceGraphEvent(g, {
      type: "tool_call",
      id: "tc-1",
      runId: "r1",
      agentId: "a1",
      name: "search",
      input: "auth",
    });
    g = reduceGraphEvent(g, {
      type: "harness_start",
      runId: "r2",
      agentId: "sub",
      parentId: "tc-1",
    });
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t2",
      runId: "r2",
      agentId: "sub",
      content: "Searching...",
    });
    g = reduceGraphEvent(g, {
      type: "harness_end",
      runId: "r2",
      agentId: "sub",
    });
    g = reduceGraphEvent(g, {
      type: "tool_result",
      id: "tc-1",
      runId: "r1",
      agentId: "a1",
      name: "search",
      output: ["auth.ts"],
    });
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t3",
      runId: "r1",
      agentId: "a1",
      content: "Found auth.ts",
    });

    const tcEdges = g.edges.get("tc-1") ?? [];
    expect(tcEdges).toContain("r2:start");
    expect(tcEdges).toContain("tc-1:result");
    expect(g.edges.get("tc-1:result")).toEqual(["t3"]);
    expect(g.edges.get("r2:start")).toEqual(["t2"]);
    expect(g.edges.get("t2")).toEqual(["r2:end"]);
  });

  test("parentId as runId creates edge from last node of that run", () => {
    let g = createInitialGraph();
    g = reduceGraphEvent(g, {
      type: "harness_start",
      runId: "agent-1",
      agentId: "a1",
    });
    g = reduceGraphEvent(g, {
      type: "text",
      id: "t1",
      runId: "agent-1",
      agentId: "a1",
      content: "Thinking",
    });
    g = reduceGraphEvent(g, {
      type: "harness_start",
      runId: "turn-1",
      agentId: "provider",
      parentId: "agent-1",
    });
    const t1Edges = g.edges.get("t1") ?? [];
    expect(t1Edges).toContain("turn-1:start");
  });
});
