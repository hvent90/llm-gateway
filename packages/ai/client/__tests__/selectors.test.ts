import { describe, test, expect } from "bun:test";
import { createInitialState, reduceEvent } from "../graph";
import {
  getRoots,
  getChildren,
  getText,
  getToolCalls,
  getStatus,
  getContentBlocks,
  getRole,
  getUsage,
  getToolCallCount,
} from "../selectors";

describe("Selectors", () => {
  test("getRoots returns nodes with no parentId", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "root-1",
      id: "e1",
      agentId: "a1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-1",
      id: "e2",
      agentId: "a1",
      parentId: "root-1",
      content: "World",
    });

    const roots = getRoots(state);
    expect(roots).toEqual(["root-1"]);
  });

  test("getChildren returns nodes with matching parentId", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "parent",
      id: "e1",
      agentId: "a1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-1",
      id: "e2",
      agentId: "a1",
      parentId: "parent",
      content: "A",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-2",
      id: "e3",
      agentId: "a1",
      parentId: "parent",
      content: "B",
    });

    const children = getChildren(state, "parent");
    expect(children.sort()).toEqual(["child-1", "child-2"]);
  });

  test("getText concatenates text event content", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      agentId: "a1",
      content: "Hello ",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e2",
      agentId: "a1",
      content: "world",
    });

    expect(getText(state, "run-1")).toBe("Hello world");
  });

  test("getText ignores reasoning events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r1",
      agentId: "a1",
      content: "Thinking...",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
      agentId: "a1",
      content: "Answer",
    });

    expect(getText(state, "run-1")).toBe("Answer");
  });

  test("getToolCalls extracts tool_call events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-2",
      agentId: "a1",
      name: "read",
      input: { path: "/tmp" },
    });

    const toolCalls = getToolCalls(state, "run-1");
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0]!.name).toBe("bash");
    expect(toolCalls[1]!.name).toBe("read");
  });

  test("getStatus returns streaming after harness_start", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "harness_start",
      runId: "run-1",
      agentId: "a1",
    });

    expect(getStatus(state, "run-1")).toBe("streaming");
  });

  test("getStatus returns complete after harness_end", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "harness_start",
      runId: "run-1",
      agentId: "a1",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      agentId: "a1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "harness_end",
      runId: "run-1",
      agentId: "a1",
    });

    expect(getStatus(state, "run-1")).toBe("complete");
  });

  test("getStatus returns complete for node without harness events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      agentId: "a1",
      content: "Hello",
    });

    expect(getStatus(state, "run-1")).toBe("complete");
  });

  test("getStatus returns error when error event present", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "harness_start",
      runId: "run-1",
      agentId: "a1",
    });
    state = reduceEvent(state, {
      type: "error",
      runId: "run-1",
      agentId: "a1",
      message: "Failed",
    });

    expect(getStatus(state, "run-1")).toBe("error");
  });

  test("getStatus returns complete for unknown runId", () => {
    const state = createInitialState();
    expect(getStatus(state, "nonexistent")).toBe("complete");
  });
});

describe("getContentBlocks", () => {
  test("returns text blocks from text events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      agentId: "a1",
      content: "Hello ",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e2",
      agentId: "a1",
      content: "world",
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks).toEqual([{ type: "text", content: "Hello world" }]);
  });

  test("merges consecutive text events into one block", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      agentId: "a1",
      content: "A",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e2",
      agentId: "a1",
      content: "B",
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ type: "text", content: "AB" });
  });

  test("merges consecutive reasoning events into one block", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r1",
      agentId: "a1",
      content: "Thinking",
    });
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r2",
      agentId: "a1",
      content: "...",
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ type: "reasoning", content: "Thinking..." });
  });

  test("creates separate blocks when type switches", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r1",
      agentId: "a1",
      content: "Hmm",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
      agentId: "a1",
      content: "Answer",
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toEqual({ type: "reasoning", content: "Hmm" });
    expect(blocks[1]).toEqual({ type: "text", content: "Answer" });
  });

  test("creates tool_call blocks with output from tool_result", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_result",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      output: { stdout: "file.txt" },
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({
      type: "tool_call",
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
      output: { stdout: "file.txt" },
    });
  });

  test("tool_call without result has no output", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks[0]).toEqual({
      type: "tool_call",
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
    });
  });

  test("handles mixed event sequence", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r1",
      agentId: "a1",
      content: "Let me think",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
      agentId: "a1",
      content: "I'll use a tool",
    });
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_result",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      output: "files",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t2",
      agentId: "a1",
      content: "Here are the files",
    });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks.length).toBe(4);
    expect(blocks[0]!.type).toBe("reasoning");
    expect(blocks[1]).toEqual({ type: "text", content: "I'll use a tool" });
    expect(blocks[2]!.type).toBe("tool_call");
    expect(blocks[3]).toEqual({ type: "text", content: "Here are the files" });
  });

  test("returns empty array for unknown runId", () => {
    const state = createInitialState();
    expect(getContentBlocks(state, "nonexistent")).toEqual([]);
  });

  test("skips error and relay events in content blocks", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
      agentId: "a1",
      content: "Hello",
    });
    state = reduceEvent(state, { type: "error", runId: "run-1", agentId: "a1", message: "oops" });
    const blocks = getContentBlocks(state, "run-1");
    expect(blocks).toEqual([{ type: "text", content: "Hello" }]);
  });
});

describe("getRole", () => {
  test("returns assistant for server event nodes", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      agentId: "a1",
      content: "Hi",
    });
    expect(getRole(state, "run-1")).toBe("assistant");
  });

  test("returns undefined for unknown runId", () => {
    const state = createInitialState();
    expect(getRole(state, "nonexistent")).toBeUndefined();
  });
});

describe("getUsage", () => {
  test("returns zeros for unknown runId", () => {
    const state = createInitialState();
    expect(getUsage(state, "nonexistent")).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test("sums multiple usage events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "usage",
      runId: "run-1",
      agentId: "a1",
      inputTokens: 100,
      outputTokens: 50,
    });
    state = reduceEvent(state, {
      type: "usage",
      runId: "run-1",
      agentId: "a1",
      inputTokens: 200,
      outputTokens: 75,
    });
    expect(getUsage(state, "run-1")).toEqual({ inputTokens: 300, outputTokens: 125 });
  });
});

describe("getToolCallCount", () => {
  test("returns 0 for unknown runId", () => {
    const state = createInitialState();
    expect(getToolCallCount(state, "nonexistent")).toBe(0);
  });

  test("counts tool_call events correctly", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
      agentId: "a1",
      content: "some text",
    });
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-2",
      agentId: "a1",
      name: "read",
      input: { path: "/tmp" },
    });
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-3",
      agentId: "a1",
      name: "write",
      input: { path: "/tmp/out" },
    });
    expect(getToolCallCount(state, "run-1")).toBe(3);
  });
});
