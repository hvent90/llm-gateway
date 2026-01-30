import { describe, test, expect } from "bun:test";
import { createInitialGraph, reduceGraphEvent } from "../graph";
import { projectThread } from "../projections/thread";
import type { GraphBuilderState } from "../types";
import type { GraphEvent } from "../graph";

/** Helper: reduce a sequence of events into a graph. */
function buildGraph(events: GraphEvent[]): GraphBuilderState {
  let g = createInitialGraph();
  for (const e of events) g = reduceGraphEvent(g, e);
  return g;
}

describe("Thread Projection", () => {
  test("simple chat: flat list, no branches", () => {
    const g = buildGraph([
      { type: "user" as any, runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi there!" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const userNodes = view.filter((n) => n.content.kind === "user");
    const textNodes = view.filter((n) => n.content.kind === "text");
    expect(userNodes.length).toBe(1);
    expect(textNodes.length).toBeGreaterThanOrEqual(1);
    for (const n of view) {
      expect(n.branches).toEqual([]);
    }
  });

  test("merges consecutive text nodes into one ViewNode", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "world" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const textNodes = view.filter((n) => n.content.kind === "text");
    expect(textNodes.length).toBe(1);
    if (textNodes[0]!.content.kind === "text") {
      expect(textNodes[0]!.content.text).toBe("Hello world");
    }
  });

  test("merges consecutive reasoning nodes", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "reasoning", id: "r1a", runId: "r1", agentId: "a1", content: "Thinking" },
      { type: "reasoning", id: "r1b", runId: "r1", agentId: "a1", content: "..." },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const reasoningNodes = view.filter((n) => n.content.kind === "reasoning");
    expect(reasoningNodes.length).toBe(1);
    if (reasoningNodes[0]!.content.kind === "reasoning") {
      expect(reasoningNodes[0]!.content.text).toBe("Thinking...");
    }
  });

  test("pairs tool_call with tool_result", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc-1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool_result",
        id: "tc-1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        output: "files",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNodes = view.filter((n) => n.content.kind === "tool_call");
    expect(tcNodes.length).toBe(1);
    if (tcNodes[0]!.content.kind === "tool_call") {
      expect(tcNodes[0]!.content.name).toBe("bash");
      expect(tcNodes[0]!.content.output).toBe("files");
    }
  });

  test("tool_call without result has no output", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc-1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNodes = view.filter((n) => n.content.kind === "tool_call");
    if (tcNodes[0]!.content.kind === "tool_call") {
      expect(tcNodes[0]!.content.output).toBeUndefined();
    }
  });

  test("subagent creates a branch on the tool_call node", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Let me search." },
      { type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1", name: "search", input: "auth" },
      { type: "harness_start", runId: "r2", agentId: "sub", parentId: "tc-1" },
      { type: "text", id: "t2", runId: "r2", agentId: "sub", content: "Searching..." },
      { type: "harness_end", runId: "r2", agentId: "sub" },
      {
        type: "tool_result",
        id: "tc-1",
        runId: "r1",
        agentId: "a1",
        name: "search",
        output: ["auth.ts"],
      },
      { type: "text", id: "t3", runId: "r1", agentId: "a1", content: "Found it." },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);

    const tcNode = view.find((n) => n.content.kind === "tool_call");
    expect(tcNode).toBeDefined();
    expect(tcNode!.branches.length).toBe(1);

    const branch = tcNode!.branches[0]!;
    const subText = branch.find((n) => n.content.kind === "text");
    expect(subText).toBeDefined();
    if (subText!.content.kind === "text") {
      expect(subText!.content.text).toBe("Searching...");
    }

    const resultNode = view.find((n) => n.content.kind === "tool_call" && n.content.output != null);
    expect(resultNode).toBeDefined();
    const finalText = view.find((n) => n.content.kind === "text" && n.content.text === "Found it.");
    expect(finalText).toBeDefined();
  });

  test("parallel subagents create multiple branches", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc-1", runId: "r1", agentId: "a1", name: "search", input: "x" },
      { type: "harness_start", runId: "r2a", agentId: "sub-a", parentId: "tc-1" },
      { type: "text", id: "t2a", runId: "r2a", agentId: "sub-a", content: "Path A" },
      { type: "harness_end", runId: "r2a", agentId: "sub-a" },
      { type: "harness_start", runId: "r2b", agentId: "sub-b", parentId: "tc-1" },
      { type: "text", id: "t2b", runId: "r2b", agentId: "sub-b", content: "Path B" },
      { type: "harness_end", runId: "r2b", agentId: "sub-b" },
      {
        type: "tool_result",
        id: "tc-1",
        runId: "r1",
        agentId: "a1",
        name: "search",
        output: "done",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNode = view.find((n) => n.content.kind === "tool_call");
    expect(tcNode!.branches.length).toBe(2);
  });

  test("skips harness_start, harness_end, usage, error nodes from visible output", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "usage", runId: "r1", agentId: "a1", inputTokens: 100, outputTokens: 50 },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(1);
    expect(view[0]!.content.kind).toBe("text");
  });

  test("status reflects streaming vs complete", () => {
    const streaming = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
    ]);
    const viewStreaming = projectThread(streaming);
    expect(viewStreaming[0]!.status).toBe("streaming");

    const complete = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const viewComplete = projectThread(complete);
    expect(viewComplete[0]!.status).toBe("complete");
  });

  test("empty graph produces empty view", () => {
    const g = createInitialGraph();
    const view = projectThread(g);
    expect(view).toEqual([]);
  });
});
