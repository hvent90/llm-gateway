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
});
