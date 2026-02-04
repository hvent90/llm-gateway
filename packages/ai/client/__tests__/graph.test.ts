import { describe, test, expect } from "bun:test";
import { createGraph, reduceEvent } from "../graph";
import type { Graph } from "../types";
import type { ContentPart } from "../../types";

describe("Graph Reducer", () => {
  test("createGraph returns empty graph", () => {
    const g = createGraph();
    expect(g.nodes.size).toBe(0);
    expect(g.edges.size).toBe(0);
    expect(g.lastNodeByRunId.size).toBe(0);
  });

  test("reduceEvent ignores connected events", () => {
    const g = createGraph();
    const g2 = reduceEvent(g, { type: "connected", sessionId: "s-1" });
    expect(g2.nodes.size).toBe(0);
  });

  test("text event creates a node", () => {
    const g = reduceEvent(createGraph(), {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Hello",
    });
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("t1")!;
    expect(node.kind).toBe("text");
    expect(node.runId).toBe("r1");
    if (node.kind === "text") expect(node.content).toBe("Hello");
  });

  test("streaming text with same id appends content", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " });
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "world" });
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("t1")!;
    if (node.kind === "text") expect(node.content).toBe("Hello world");
  });

  test("streaming reasoning with same id appends content", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "reasoning",
      id: "r1",
      runId: "run1",
      agentId: "a1",
      content: "Think",
    });
    g = reduceEvent(g, {
      type: "reasoning",
      id: "r1",
      runId: "run1",
      agentId: "a1",
      content: "ing",
    });
    const node = g.nodes.get("r1")!;
    if (node.kind === "reasoning") expect(node.content).toBe("Thinking");
  });

  test("sequential events in same run create edges", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "harness_start", runId: "r1", agentId: "a1" });
    g = reduceEvent(g, { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" });
    g = reduceEvent(g, { type: "harness_end", runId: "r1", agentId: "a1" });

    // harness_start -> text -> harness_end
    const hsId = "r1:harness_start";
    expect(g.edges.get(hsId)).toEqual(["t1"]);
    expect(g.edges.get("t1")).toEqual(["r1:harness_end"]);
  });

  test("parentId creates cross-run edge", () => {
    let g = createGraph();
    // Parent run: tool_call
    g = reduceEvent(g, {
      type: "tool_call",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "agent",
      input: { task: "go" },
    });
    // Child run starts with parentId pointing to tc1
    g = reduceEvent(g, {
      type: "harness_start",
      runId: "r2",
      agentId: "a2",
      parentId: "tc1",
    });
    // tc1 should have an edge to the child's harness_start
    const tc1Edges = g.edges.get("tc1") ?? [];
    expect(tc1Edges).toContain("r2:harness_start");
  });

  test("tool_call then tool_result in same run creates sequential edge", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "tool_call",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      input: { cmd: "ls" },
    });
    g = reduceEvent(g, {
      type: "tool_result",
      id: "tc1",
      runId: "r1",
      agentId: "a1",
      name: "bash",
      output: "file.txt",
    });
    // tool_call -> tool_result (sequential in same run)
    expect(g.edges.get("tc1")).toContain("tc1:result");
  });

  test("events without id get deterministic generated ids", () => {
    let g = createGraph();
    g = reduceEvent(g, { type: "harness_start", runId: "r1", agentId: "a1" });
    expect(g.nodes.has("r1:harness_start")).toBe(true);

    g = reduceEvent(g, { type: "harness_end", runId: "r1", agentId: "a1" });
    expect(g.nodes.has("r1:harness_end")).toBe(true);

    g = reduceEvent(g, { type: "error", runId: "r1", agentId: "a1", message: "oops" });
    expect(g.nodes.has("r1:error")).toBe(true);
  });

  test("usage events use counter for unique ids", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "usage",
      runId: "r1",
      agentId: "a1",
      inputTokens: 10,
      outputTokens: 5,
    });
    g = reduceEvent(g, {
      type: "usage",
      runId: "r1",
      agentId: "a1",
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(g.nodes.size).toBe(2);
  });

  test("state is immutable", () => {
    const g1 = createGraph();
    const g2 = reduceEvent(g1, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Hi",
    });
    expect(g1.nodes.size).toBe(0);
    expect(g2.nodes.size).toBe(1);
  });

  test("subagent example from design doc", () => {
    let g = createGraph();
    // Parent agent: text then tool_call
    g = reduceEvent(g, { type: "harness_start", runId: "r2", agentId: "a1" });
    g = reduceEvent(g, {
      type: "text",
      id: "t1",
      runId: "r2",
      agentId: "a1",
      content: "Let me search.",
    });
    g = reduceEvent(g, {
      type: "tool_call",
      id: "tc1",
      runId: "r2",
      agentId: "a1",
      name: "search",
      input: "auth",
    });
    // Subagent starts (parentId = tc1)
    g = reduceEvent(g, { type: "harness_start", runId: "r3", agentId: "a2", parentId: "tc1" });
    g = reduceEvent(g, {
      type: "text",
      id: "t2",
      runId: "r3",
      agentId: "a2",
      parentId: "tc1",
      content: "Searching...",
    });
    g = reduceEvent(g, { type: "harness_end", runId: "r3", agentId: "a2", parentId: "tc1" });
    // Parent continues: tool_result then more text
    g = reduceEvent(g, {
      type: "tool_result",
      id: "tc1",
      runId: "r2",
      agentId: "a1",
      name: "search",
      output: ["auth.ts"],
    });
    g = reduceEvent(g, {
      type: "text",
      id: "t3",
      runId: "r2",
      agentId: "a1",
      content: "Found auth.ts",
    });
    g = reduceEvent(g, { type: "harness_end", runId: "r2", agentId: "a1" });

    // Verify edge structure
    // tc1 should have edges to both:
    //   - r3:harness_start (cross-run via parentId)
    //   - tc1:result (sequential in r2)
    const tc1Edges = g.edges.get("tc1") ?? [];
    expect(tc1Edges).toContain("r3:harness_start");
    expect(tc1Edges).toContain("tc1:result");
  });

  test("user event creates user node", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "user",
      runId: "u1",
      content: "Hello",
    } as any);
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("u1:user")!;
    expect(node.kind).toBe("user");
  });

  test("user event with ContentPart[] creates user node with structured content", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Look at this image" },
      { type: "image", mediaType: "image/png", data: "base64data" },
    ];
    let g = createGraph();
    g = reduceEvent(g, {
      type: "user",
      runId: "u1",
      content: parts,
    } as any);
    expect(g.nodes.size).toBe(1);
    const node = g.nodes.get("u1:user")!;
    expect(node.kind).toBe("user");
    if (node.kind === "user") {
      expect(Array.isArray(node.content)).toBe(true);
      expect(node.content).toEqual(parts);
    }
  });

  test("relay event creates relay node", () => {
    let g = createGraph();
    g = reduceEvent(g, {
      type: "relay",
      kind: "permission",
      id: "relay-1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc1",
      tool: "bash",
      params: { command: "rm" },
    });
    expect(g.nodes.has("relay-1")).toBe(true);
    const node = g.nodes.get("relay-1")!;
    expect(node.kind).toBe("relay");
  });
});
