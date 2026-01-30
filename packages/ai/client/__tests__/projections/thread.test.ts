import { describe, test, expect } from "bun:test";
import { createGraph, reduceEvent, type GraphEvent } from "../../graph";
import { projectThread } from "../../projections/thread";
import type { ViewNode } from "../../projections/thread";

function buildGraph(events: GraphEvent[]) {
  let g = createGraph();
  for (const e of events) g = reduceEvent(g, e);
  return g;
}

describe("Thread Projection", () => {
  test("empty graph produces empty view", () => {
    expect(projectThread(createGraph())).toEqual([]);
  });

  test("simple text response produces flat list", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(1);
    expect(view[0]!.content.kind).toBe("text");
    if (view[0]!.content.kind === "text") expect(view[0]!.content.text).toBe("Hello");
    expect(view[0]!.status).toBe("complete");
    expect(view[0]!.branches).toEqual([]);
  });

  test("consecutive text nodes merge into one ViewNode", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "world" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const textNodes = view.filter((v) => v.content.kind === "text");
    expect(textNodes.length).toBe(1);
    if (textNodes[0]!.content.kind === "text") {
      expect(textNodes[0]!.content.text).toBe("Hello world");
    }
  });

  test("reasoning then text produces two ViewNodes", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "reasoning", id: "r1x", runId: "r1", agentId: "a1", content: "Hmm" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Answer" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(2);
    expect(view[0]!.content.kind).toBe("reasoning");
    expect(view[1]!.content.kind).toBe("text");
  });

  test("tool_call with subagent creates branch", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Searching" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "search", input: "auth" },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", parentId: "tc1", content: "Found it" },
      { type: "harness_end", runId: "r2", agentId: "a2", parentId: "tc1" },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "search",
        output: ["auth.ts"],
      },
      { type: "text", id: "t3", runId: "r1", agentId: "a1", content: "Done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNode = view.find((v) => v.content.kind === "tool_call");
    expect(tcNode).toBeDefined();
    expect(tcNode!.branches.length).toBe(1);
    expect(tcNode!.branches[0]!.length).toBeGreaterThan(0);
    if (tcNode!.content.kind === "tool_call") {
      expect(tcNode!.content.output).toEqual(["auth.ts"]);
    }
  });

  test("status is streaming when harness_start without harness_end", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "typing..." },
    ]);
    const view = projectThread(g);
    expect(view[0]!.status).toBe("streaming");
  });

  test("status is error when error node present", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "error", runId: "r1", agentId: "a1", message: "boom" },
    ]);
    const view = projectThread(g);
    const errorNode = view.find((v) => v.status === "error");
    expect(errorNode).toBeDefined();
  });

  test("user event produces user ViewNode", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" } as any]);
    const view = projectThread(g);
    expect(view.length).toBe(1);
    expect(view[0]!.role).toBe("user");
    expect(view[0]!.content.kind).toBe("user");
  });

  test("disconnected components render in insertion order", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" } as any,
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
      { type: "user", runId: "u2", content: "Follow-up" } as any,
      { type: "harness_start", runId: "r2", agentId: "a2" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", content: "Sure" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
    ]);
    const view = projectThread(g);
    expect(view.length).toBe(4);
    expect(view[0]!.role).toBe("user");
    expect(view[1]!.role).toBe("assistant");
    expect(view[2]!.role).toBe("user");
    expect(view[3]!.role).toBe("assistant");
  });

  test("cross-run promotion: user message with linked assistant reply renders flat", () => {
    // When a user message has a single cross-run edge (assistant reply via parentId),
    // the reply should be promoted to a continuation — rendered flat, not as a branch.
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" } as any,
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", parentId: "u1:user", content: "Hi there" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    // Should render as flat: [user, text] — not user with a branch
    expect(view.length).toBe(2);
    expect(view[0]!.role).toBe("user");
    expect(view[0]!.branches).toEqual([]);
    expect(view[1]!.role).toBe("assistant");
    if (view[1]!.content.kind === "text") {
      expect(view[1]!.content.text).toBe("Hi there");
    }
  });

  test("conversation fork: user message with multiple assistant replies creates branches", () => {
    // When a user message has multiple cross-run edges (forking conversation),
    // the first reply is promoted to continuation and the rest become branches.
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" } as any,
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", parentId: "u1:user", content: "Reply A" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "u1:user" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", parentId: "u1:user", content: "Reply B" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
    ]);
    const view = projectThread(g);
    // First reply promoted to continuation (flat), second becomes a branch on user node
    const userNode = view.find((v) => v.role === "user");
    expect(userNode).toBeDefined();
    expect(userNode!.branches.length).toBe(1);
    // The promoted reply should follow the user node in the flat list
    const textNodes = view.filter((v) => v.content.kind === "text");
    expect(textNodes.length).toBeGreaterThanOrEqual(1);
    // The branch should contain the second reply
    const branchTexts = userNode!.branches[0]!;
    expect(branchTexts.length).toBeGreaterThan(0);
    const branchText = branchTexts.find((v) => v.content.kind === "text");
    expect(branchText).toBeDefined();
    if (branchText!.content.kind === "text") {
      expect(branchText!.content.text).toBe("Reply B");
    }
  });

  test("text node with cross-run branch renders the branch", () => {
    // Any content node (not just tool_call) should be able to have branches
    // when it has cross-run edges.
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Main text" },
      // A cross-run edge from t1 to a child run
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "t1" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", parentId: "t1", content: "Branch text" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const mainNode = view.find((v) => v.content.kind === "text" && v.id === "t1");
    expect(mainNode).toBeDefined();
    // The cross-run child should appear as a branch
    expect(mainNode!.branches.length).toBe(1);
    expect(mainNode!.branches[0]!.length).toBeGreaterThan(0);
  });

  test("parallel subagents create multiple branches", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "tool_call", id: "tc1", runId: "r1", agentId: "a1", name: "search", input: "x" },
      { type: "harness_start", runId: "r2a", agentId: "a2", parentId: "tc1" },
      { type: "text", id: "t2a", runId: "r2a", agentId: "a2", parentId: "tc1", content: "A" },
      { type: "harness_end", runId: "r2a", agentId: "a2", parentId: "tc1" },
      { type: "harness_start", runId: "r2b", agentId: "a3", parentId: "tc1" },
      { type: "text", id: "t2b", runId: "r2b", agentId: "a3", parentId: "tc1", content: "B" },
      { type: "harness_end", runId: "r2b", agentId: "a3", parentId: "tc1" },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "search",
        output: "done",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const view = projectThread(g);
    const tcNode = view.find((v) => v.content.kind === "tool_call");
    expect(tcNode).toBeDefined();
    expect(tcNode!.branches.length).toBe(2);
  });
});
