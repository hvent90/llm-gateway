import { describe, test, expect } from "bun:test";
import {
  createInitialConversation,
  reduceConversation,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "../conversation";

describe("Conversation Reducer", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
    expect(state.graph.edges.size).toBe(0);
    expect(state.sessionId).toBe(null);
    expect(state.pendingRelays).toEqual([]);
    expect(state.grantedTools.size).toBe(0);
    expect(state.activeStreams.size).toBe(0);
    expect(state.isConnected).toBe(false);
  });

  test("connected event sets sessionId", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "connected", sessionId: "s-1" });
    expect(state.sessionId).toBe("s-1");
    expect(state.graph.nodes.size).toBe(0);
  });

  test("user event creates user node in graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "user", runId: "u1", content: "Hello" });
    expect(state.graph.nodes.size).toBe(1);
    const node = state.graph.nodes.get("u1:user")!;
    expect(node.kind).toBe("user");
    if (node.kind === "user") expect(node.content).toBe("Hello");
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
    expect(state.graph.nodes.size).toBe(1);
    expect(state.graph.nodes.get("t1")!.kind).toBe("text");
  });

  test("relay event appends to pendingRelays and creates graph node", () => {
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
    expect(state.graph.nodes.has("r-1")).toBe(true);
  });

  test("relay_resolved removes relay and grants tool if approved", () => {
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
    expect(state.grantedTools.has("bash")).toBe(true);
  });

  test("harness_start adds to activeStreams and delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "harness_start", runId: "r1", agentId: "a1" });
    expect(state.activeStreams.has("r1")).toBe(true);
    expect(state.graph.nodes.has("r1:harness_start")).toBe(true);
  });

  test("harness_end removes from activeStreams and delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "harness_start", runId: "r1", agentId: "a1" });
    state = reduceConversation(state, { type: "harness_end", runId: "r1", agentId: "a1" });
    expect(state.activeStreams.has("r1")).toBe(false);
    expect(state.graph.nodes.has("r1:harness_end")).toBe(true);
  });

  test("stream_start/stream_end toggle isConnected", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);
    state = reduceConversation(state, { type: "stream_end" });
    expect(state.isConnected).toBe(false);
  });

  test("getAutoApprovableRelays returns relays whose tool is already granted", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-0",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-0",
      tool: "read_file",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved",
      relayId: "r-0",
      tool: "read_file",
      approved: true,
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "read_file",
      params: { path: "/a" },
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-2",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-2",
      tool: "bash",
      params: { command: "ls" },
    });
    const auto = getAutoApprovableRelays(state);
    expect(auto.length).toBe(1);
    expect(auto[0]!.relayId).toBe("r-1");
  });

  test("getSameToolRelays returns all pending relays matching a tool type", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "read_file",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-2",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-2",
      tool: "read_file",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-3",
      runId: "r1",
      agentId: "a1",
      toolCallId: "tc-3",
      tool: "bash",
      params: {},
    });
    const same = getSameToolRelays(state, "read_file");
    expect(same.length).toBe(2);
  });
});
