import { describe, test, expect } from "bun:test";
import {
  createInitialConversation,
  reduceConversation,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "../conversation";
import { getRoots, getChildren, getContentBlocks, getRole } from "../selectors";

describe("Conversation Reducer", () => {
  test("createInitialConversation returns empty state", () => {
    const state = createInitialConversation();
    expect(state.graph.nodes.size).toBe(0);
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
    state = reduceConversation(state, { type: "user", runId: "user-1", content: "Hello" });
    expect(state.graph.nodes.size).toBe(1);
    expect(getRole(state.graph, "user-1")).toBe("user");
    expect(getContentBlocks(state.graph, "user-1")).toEqual([{ type: "text", content: "Hello" }]);
  });

  test("user event with parentId creates child node", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text",
      id: "e1",
      runId: "run-1",
      agentId: "a1",
      content: "Hi",
    });
    state = reduceConversation(state, {
      type: "user",
      runId: "user-1",
      parentId: "run-1",
      content: "Reply",
    });
    expect(getChildren(state.graph, "run-1")).toEqual(["user-1"]);
  });

  test("text events delegate to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "text",
      id: "e1",
      runId: "run-1",
      agentId: "a1",
      content: "Hello",
    });
    expect(state.graph.nodes.size).toBe(1);
    expect(getRole(state.graph, "run-1")).toBe("assistant");
  });

  test("relay event appends to pendingRelays", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "bash",
      params: { command: "rm -rf" },
    });
    expect(state.pendingRelays.length).toBe(1);
    expect(state.pendingRelays[0]!.relayId).toBe("r-1");
    expect(state.pendingRelays[0]!.tool).toBe("bash");
  });

  test("multiple relays accumulate", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "bash",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-2",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-2",
      tool: "read",
      params: {},
    });
    expect(state.pendingRelays.length).toBe(2);
  });

  test("relay_resolved removes relay and grants tool if approved", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
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

  test("relay_resolved with denied does not grant tool", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "bash",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay_resolved",
      relayId: "r-1",
      tool: "bash",
      approved: false,
    });
    expect(state.pendingRelays.length).toBe(0);
    expect(state.grantedTools.has("bash")).toBe(false);
  });

  test("stream_start sets isConnected to true", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);
  });

  test("stream_end sets isConnected to false", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "stream_start" });
    state = reduceConversation(state, { type: "stream_end" });
    expect(state.isConnected).toBe(false);
  });

  test("harness_start adds runId to activeStreams and delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "harness_start",
      runId: "run-1",
      agentId: "agent-1",
    });
    expect(state.activeStreams.has("run-1")).toBe(true);
    expect(state.graph.nodes.has("run-1")).toBe(true);
    expect(state.graph.nodes.get("run-1")!.events[0]!.type).toBe("harness_start");
  });

  test("harness_end removes runId from activeStreams and delegates to graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "harness_start",
      runId: "run-1",
      agentId: "agent-1",
    });
    state = reduceConversation(state, {
      type: "harness_end",
      runId: "run-1",
      agentId: "agent-1",
    });
    expect(state.activeStreams.has("run-1")).toBe(false);
    expect(state.graph.nodes.get("run-1")!.events).toHaveLength(2);
    expect(state.graph.nodes.get("run-1")!.events[1]!.type).toBe("harness_end");
  });

  test("harness_start with parentId creates child node in graph", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "harness_start",
      runId: "parent-run",
      agentId: "agent-1",
    });
    state = reduceConversation(state, {
      type: "harness_start",
      runId: "child-run",
      agentId: "agent-2",
      parentId: "parent-run",
    });
    expect(state.activeStreams.has("parent-run")).toBe(true);
    expect(state.activeStreams.has("child-run")).toBe(true);
    expect(state.graph.nodes.get("child-run")!.parentId).toBe("parent-run");
  });

  test("multiple harness streams tracked independently", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "harness_start",
      runId: "run-1",
      agentId: "agent-1",
    });
    state = reduceConversation(state, {
      type: "harness_start",
      runId: "run-2",
      agentId: "agent-2",
    });
    expect(state.activeStreams.size).toBe(2);
    state = reduceConversation(state, {
      type: "harness_end",
      runId: "run-1",
      agentId: "agent-1",
    });
    expect(state.activeStreams.size).toBe(1);
    expect(state.activeStreams.has("run-2")).toBe(true);
  });

  test("resolving one relay leaves other same-type relays pending", () => {
    let state = createInitialConversation();
    // Add 3 read_file relays and 1 bash relay
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "read_file",
      params: { path: "/a" },
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-2",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-2",
      tool: "read_file",
      params: { path: "/b" },
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-3",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-3",
      tool: "read_file",
      params: { path: "/c" },
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-4",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-4",
      tool: "bash",
      params: { command: "ls" },
    });
    expect(state.pendingRelays.length).toBe(4);

    // Resolve r-1 with grant — grants read_file, removes r-1
    state = reduceConversation(state, {
      type: "relay_resolved",
      relayId: "r-1",
      tool: "read_file",
      approved: true,
    });
    expect(state.grantedTools.has("read_file")).toBe(true);
    expect(state.pendingRelays.length).toBe(3);
    // r-2 and r-3 (read_file) still pending — reducer doesn't auto-resolve siblings
    expect(state.pendingRelays.map((r) => r.relayId)).toEqual(["r-2", "r-3", "r-4"]);

    // Resolve r-2 without granting (tool already granted)
    state = reduceConversation(state, {
      type: "relay_resolved",
      relayId: "r-2",
      tool: "read_file",
      approved: false,
    });
    expect(state.pendingRelays.length).toBe(2);

    // Resolve r-3
    state = reduceConversation(state, {
      type: "relay_resolved",
      relayId: "r-3",
      tool: "read_file",
      approved: false,
    });
    expect(state.pendingRelays.length).toBe(1);
    // bash relay still pending
    expect(state.pendingRelays[0]!.relayId).toBe("r-4");
    expect(state.pendingRelays[0]!.tool).toBe("bash");
    // read_file still granted, bash not
    expect(state.grantedTools.has("read_file")).toBe(true);
    expect(state.grantedTools.has("bash")).toBe(false);
  });

  test("getAutoApprovableRelays returns relays whose tool is already granted", () => {
    let state = createInitialConversation();
    // Grant read_file
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-0",
      runId: "run-1",
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
    expect(state.grantedTools.has("read_file")).toBe(true);
    expect(state.pendingRelays.length).toBe(0);

    // Now add new relays — read_file should be auto-approvable, bash should not
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "read_file",
      params: { path: "/a" },
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-2",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-2",
      tool: "bash",
      params: { command: "ls" },
    });

    const autoApprovable = getAutoApprovableRelays(state);
    expect(autoApprovable.length).toBe(1);
    expect(autoApprovable[0]!.relayId).toBe("r-1");
    expect(autoApprovable[0]!.tool).toBe("read_file");
  });

  test("getAutoApprovableRelays returns empty when no tools granted", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "bash",
      params: {},
    });
    expect(getAutoApprovableRelays(state)).toEqual([]);
  });

  test("getSameToolRelays returns all pending relays matching a tool type", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-1",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-1",
      tool: "read_file",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-2",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-2",
      tool: "read_file",
      params: {},
    });
    state = reduceConversation(state, {
      type: "relay",
      kind: "permission",
      id: "r-3",
      runId: "run-1",
      agentId: "a1",
      toolCallId: "tc-3",
      tool: "bash",
      params: {},
    });

    const sameType = getSameToolRelays(state, "read_file");
    expect(sameType.length).toBe(2);
    expect(sameType.map((r: any) => r.relayId)).toEqual(["r-1", "r-2"]);
  });

  test("full conversation flow", () => {
    let state = createInitialConversation();
    state = reduceConversation(state, { type: "connected", sessionId: "s-1" });
    state = reduceConversation(state, { type: "user", runId: "user-1", content: "Hello" });
    state = reduceConversation(state, { type: "stream_start" });
    state = reduceConversation(state, {
      type: "text",
      id: "e1",
      runId: "run-1",
      agentId: "a1",
      parentId: "user-1",
      content: "Hi there!",
    });
    state = reduceConversation(state, { type: "stream_end" });

    expect(state.sessionId).toBe("s-1");
    expect(getRoots(state.graph)).toEqual(["user-1"]);
    expect(getChildren(state.graph, "user-1")).toEqual(["run-1"]);
    expect(getContentBlocks(state.graph, "user-1")).toEqual([{ type: "text", content: "Hello" }]);
    expect(getContentBlocks(state.graph, "run-1")).toEqual([
      { type: "text", content: "Hi there!" },
    ]);
    expect(state.activeStreams.size).toBe(0);
  });
});
