import { describe, test, expect } from "bun:test";
import { createInitialConversation, reduceConversation } from "../conversation";

describe("Conversation Layer", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
    expect(state.userMessages.length).toBe(0);
    expect(state.pending).toBe(null);
    expect(state.nextMessageId).toBe(1);
  });

  test("reduceConversation handles user events", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "user",
      content: "Hello!",
      timestamp: 1000,
    });

    expect(state.userMessages.length).toBe(1);
    expect(state.userMessages[0].content).toBe("Hello!");
    expect(state.userMessages[0].id).toBe("user-1");
    expect(state.userMessages[0].timestamp).toBe(1000);
    expect(state.nextMessageId).toBe(2);
    expect(state.graph.nodes.size).toBe(0);
  });

  test("reduceConversation handles harness events", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hi there!",
    });

    expect(state.userMessages.length).toBe(0);
    expect(state.graph.nodes.size).toBe(1);
  });

  test("reduceConversation interleaves user and harness events", () => {
    let state = createInitialConversation();

    state = reduceConversation(state, { type: "user", content: "Hello", timestamp: 1000 });
    state = reduceConversation(state, {
      type: "text",
      runId: "run-1",
      id: "e1",
      content: "Hi!",
    });
    state = reduceConversation(state, { type: "user", content: "How are you?", timestamp: 2000 });
    state = reduceConversation(state, {
      type: "text",
      runId: "run-2",
      id: "e2",
      content: "Great!",
    });

    expect(state.userMessages.length).toBe(2);
    expect(state.userMessages[0].id).toBe("user-1");
    expect(state.userMessages[1].id).toBe("user-2");
    expect(state.nextMessageId).toBe(3);
    expect(state.graph.nodes.size).toBe(2);
  });
});
