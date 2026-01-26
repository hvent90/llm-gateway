import { describe, test, expect } from "bun:test";
import { createInitialState, reduceEvent } from "../graph";

describe("Graph State", () => {
  test("createInitialState returns empty graph", () => {
    const state = createInitialState();
    expect(state.nodes.size).toBe(0);
  });

  test("reduceEvent creates node for new runId", () => {
    const state = createInitialState();
    const newState = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "evt-1",
      content: "Hello",
    });

    expect(newState.nodes.size).toBe(1);
    expect(newState.nodes.has("run-1")).toBe(true);

    const node = newState.nodes.get("run-1")!;
    expect(node.runId).toBe("run-1");
    expect(node.events.length).toBe(1);
    expect(node.events[0].type).toBe("text");
  });

  test("reduceEvent accumulates events in same node", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "evt-1",
      content: "Hello ",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "evt-2",
      content: "world",
    });

    expect(state.nodes.size).toBe(1);
    const node = state.nodes.get("run-1")!;
    expect(node.events.length).toBe(2);
  });

  test("reduceEvent stores parentId from first event", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "child-run",
      id: "evt-1",
      parentId: "parent-run",
      content: "Hello",
    });

    const node = state.nodes.get("child-run")!;
    expect(node.parentId).toBe("parent-run");
  });

  test("reduceEvent handles tool_call events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_call",
      runId: "run-1",
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
    });

    const node = state.nodes.get("run-1")!;
    expect(node.events.length).toBe(1);
    expect(node.events[0].type).toBe("tool_call");
  });

  test("reduceEvent handles tool_result events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "tool_result",
      runId: "run-1",
      id: "tc-1",
      name: "bash",
      output: { stdout: "file.txt" },
    });

    const node = state.nodes.get("run-1")!;
    expect(node.events[0].type).toBe("tool_result");
  });

  test("reduceEvent handles error events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "error",
      runId: "run-1",
      error: new Error("Something went wrong"),
    });

    const node = state.nodes.get("run-1")!;
    expect(node.events[0].type).toBe("error");
  });

  test("reduceEvent handles reasoning events", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "reasoning",
      runId: "run-1",
      id: "r-1",
      content: "Let me think...",
    });

    const node = state.nodes.get("run-1")!;
    expect(node.events[0].type).toBe("reasoning");
  });

  test("reduceEvent creates separate nodes for different runIds", () => {
    let state = createInitialState();
    state = reduceEvent(state, {
      type: "text",
      runId: "run-1",
      id: "evt-1",
      content: "Hello",
    });
    state = reduceEvent(state, {
      type: "text",
      runId: "run-2",
      id: "evt-2",
      parentId: "run-1",
      content: "World",
    });

    expect(state.nodes.size).toBe(2);
    expect(state.nodes.has("run-1")).toBe(true);
    expect(state.nodes.has("run-2")).toBe(true);
  });

  test("state is immutable - original unchanged", () => {
    const state1 = createInitialState();
    const state2 = reduceEvent(state1, {
      type: "text",
      runId: "run-1",
      id: "evt-1",
      content: "Hello",
    });

    expect(state1.nodes.size).toBe(0);
    expect(state2.nodes.size).toBe(1);
    expect(state1.nodes).not.toBe(state2.nodes);
  });
});
