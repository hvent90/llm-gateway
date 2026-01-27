import { describe, test, expect } from "bun:test";
import { createInitialState, reduceEvent } from "../graph";
import { getRoots, getChildren, getText, getToolCalls, getStatus } from "../selectors";

describe("Selectors", () => {
  test("getRoots returns nodes with no parentId", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "root-1",
      id: "e1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-1",
      id: "e2",
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
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-1",
      id: "e2",
      parentId: "parent",
      content: "A",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "child-2",
      id: "e3",
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
      content: "Hello ",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e2",
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
      content: "Thinking...",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "t1",
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
      name: "bash",
      input: { command: "ls" },
    });
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-2",
      name: "read",
      input: { path: "/tmp" },
    });

    const toolCalls = getToolCalls(state, "run-1");
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].name).toBe("bash");
    expect(toolCalls[1].name).toBe("read");
  });

  test("getStatus returns streaming when no terminal event", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hello",
    });

    expect(getStatus(state, "run-1")).toBe("streaming");
  });

  test("getStatus returns error when error event present", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "error",
      runId: "run-1",
      error: new Error("Failed"),
    });

    expect(getStatus(state, "run-1")).toBe("error");
  });

  test("getStatus returns complete for unknown runId", () => {
    const state = createInitialState();
    expect(getStatus(state, "nonexistent")).toBe("complete");
  });
});
