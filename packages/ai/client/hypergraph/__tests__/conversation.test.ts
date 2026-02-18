import { describe, test, expect } from "bun:test";
import { createInitialConversation, reduceConversation } from "../conversation";

describe("Conversation Reducer (Hypergraph)", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
    expect(state.graph.edges.size).toBe(0);
    expect(state.active.size).toBe(0);
    expect(state.sessionId).toBe(null);
    expect(state.pendingRelays).toEqual([]);
    expect(state.isConnected).toBe(false);
  });

  test("connected event sets sessionId", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "connected", sessionId: "s-1" });
    expect(state.sessionId).toBe("s-1");
    expect(state.graph.nodes.size).toBe(0);
  });

  test("user event creates nodes in graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "user", runId: "u1", content: "Hello" });
    // Hypergraph creates chunk + block + message nodes for a user event
    expect(state.graph.nodes.size).toBeGreaterThan(0);
    // Should have an active message
    expect(state.active.size).toBe(1);
  });

  test("text event delegates to graph reducer", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text",
      id: "t1",
      runId: "r1",
      agentId: "a1",
      content: "Hello",
    });
    expect(state.graph.nodes.size).toBeGreaterThan(0);
  });

  test("relay event appends to pendingRelays and creates graph nodes", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "bash",
      params: { command: "rm -rf" },
    });
    expect(state.pendingRelays.length).toBe(1);
    expect(state.pendingRelays[0]!.relayId).toBe("r-1");
    // Hypergraph creates chunk/block nodes, check they exist
    expect(state.graph.nodes.size).toBeGreaterThan(0);
  });

  test("relay_resolved removes relay from pendingRelays", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "bash",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved",
      relayId: "r-1",
      tool: "bash",
      approved: true,
    });
    expect(state.pendingRelays.length).toBe(0);
  });

  test("harness_start delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "harness_start", runId: "r1", agentId: "a1" });
    expect(state.graph.nodes.size).toBeGreaterThan(0);
  });

  test("harness_end delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "harness_start", runId: "r1", agentId: "a1" });
    state = reduceConversation(state, { type: "harness_end", runId: "r1", agentId: "a1" });
    // Both harness_start and harness_end produce nodes
    expect(state.graph.nodes.size).toBeGreaterThan(2);
  });

  test("stream_start/stream_end toggle isConnected", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);
    state = reduceConversation(state, { type: "stream_end" });
    expect(state.isConnected).toBe(false);
  });

  test("active set is rebuilt after graph-producing events", () => {
    let state = createInitialConversation();
    // A user event produces a message node, which should be in the active set
    state = reduceConversation(state, { type: "user", runId: "u1", content: "Hello" });
    expect(state.active.size).toBe(1);
    // A second user event with a new runId also produces a message
    state = reduceConversation(state, { type: "user", runId: "u2", content: "World" });
    expect(state.active.size).toBe(2);
  });
});
