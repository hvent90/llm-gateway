import { describe, test, expect } from "bun:test";
import { createGraph } from "../primitives";
import { reduceEvent, createReducerState } from "../reducer";
import { deriveBlockContent, deriveMessageContent } from "../derived";
import { blocksOf } from "../queries";
import type { ConversationGraph } from "../types";

type GraphEvent = any;

function buildGraph(events: GraphEvent[]): ConversationGraph {
  let g = createGraph();
  let s = createReducerState();
  for (const e of events) [g, s] = reduceEvent(g, s, e);
  return g;
}

function findMessages(g: ConversationGraph): string[] {
  return [...g.nodes.values()].filter((n) => n.kind === "message").map((n) => n.id);
}

describe("deriveBlockContent", () => {
  test("text block returns text ViewContent", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello" },
    ]);
    const result = deriveBlockContent(g, "block:r1:t1");
    expect(result).toEqual({ kind: "text", text: "Hello" });
  });

  test("streaming text concatenates chunks", () => {
    const g = buildGraph([
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hello " },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "world" },
    ]);
    const result = deriveBlockContent(g, "block:r1:t1");
    expect(result).toEqual({ kind: "text", text: "Hello world" });
  });

  test("reasoning block returns reasoning ViewContent", () => {
    const g = buildGraph([
      { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "Thinking..." },
    ]);
    const result = deriveBlockContent(g, "block:run1:r1");
    expect(result).toEqual({ kind: "reasoning", text: "Thinking..." });
  });

  test("streaming reasoning concatenates chunks", () => {
    const g = buildGraph([
      { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "First " },
      { type: "reasoning", id: "r1", runId: "run1", agentId: "a1", content: "second" },
    ]);
    const result = deriveBlockContent(g, "block:run1:r1");
    expect(result).toEqual({ kind: "reasoning", text: "First second" });
  });

  test("tool_call block returns tool_call ViewContent", () => {
    const g = buildGraph([
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
    ]);
    const result = deriveBlockContent(g, "block:tc1");
    expect(result).toEqual({ kind: "tool_call", name: "bash", input: { cmd: "ls" } });
  });

  test("tool_result block returns null", () => {
    const g = buildGraph([
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        output: "file.txt",
      },
    ]);
    const result = deriveBlockContent(g, "block:tc1:result");
    expect(result).toBeNull();
  });

  test("user block returns user ViewContent", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" }]);
    const result = deriveBlockContent(g, "block:u1:user");
    expect(result).toEqual({ kind: "user", content: "Hello" });
  });

  test("error block returns error ViewContent", () => {
    const g = buildGraph([
      { type: "error", runId: "r1", agentId: "a1", message: "Something failed" },
    ]);
    const result = deriveBlockContent(g, "block:r1:error");
    expect(result).toEqual({ kind: "error", message: "Something failed" });
  });

  test("harness_start block returns null", () => {
    const g = buildGraph([{ type: "harness_start", runId: "r1", agentId: "a1" }]);
    const result = deriveBlockContent(g, "block:r1:harness_start");
    expect(result).toBeNull();
  });

  test("harness_end block returns null", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const result = deriveBlockContent(g, "block:r1:harness_end");
    expect(result).toBeNull();
  });

  test("relay block returns relay ViewContent", () => {
    const g = buildGraph([
      {
        type: "relay",
        kind: "permission",
        id: "relay1",
        runId: "r1",
        agentId: "a1",
        toolCallId: "tc1",
        tool: "bash",
        params: { cmd: "rm -rf" },
      },
    ]);
    const result = deriveBlockContent(g, "block:relay1");
    expect(result).toEqual({
      kind: "relay",
      relayKind: "permission",
      toolCallId: "tc1",
      tool: "bash",
      params: { cmd: "rm -rf" },
    });
  });

  test("nonexistent block returns null", () => {
    const g = buildGraph([]);
    const result = deriveBlockContent(g, "block:nonexistent");
    expect(result).toBeNull();
  });
});

describe("deriveMessageContent", () => {
  test("user message produces user Message", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" }]);
    const messageIds = findMessages(g);
    expect(messageIds.length).toBe(1);
    const result = deriveMessageContent(g, messageIds[0]!);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  test("assistant text produces assistant Message", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Hi there" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messageIds = findMessages(g);
    expect(messageIds.length).toBe(1);
    const result = deriveMessageContent(g, messageIds[0]!);
    expect(result).toEqual([{ role: "assistant", content: "Hi there" }]);
  });

  test("assistant with tool_call and tool_result produces assistant + tool Messages", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Let me check" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        output: "file.txt",
      },
      { type: "text", id: "t2", runId: "r1", agentId: "a1", content: "Done" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messageIds = findMessages(g);
    // text-after-tool-result creates boundary: msg:1 = [harness_start, t1, tc1, tc1:result], msg:2 = [t2, harness_end]
    expect(messageIds.length).toBe(2);

    // First message: assistant with text + tool_call, then tool result
    const msg1 = deriveMessageContent(g, messageIds[0]!);
    expect(msg1).toEqual([
      {
        role: "assistant",
        content: "Let me check",
        tool_calls: [{ id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "file.txt" },
    ]);

    // Second message: just text
    const msg2 = deriveMessageContent(g, messageIds[1]!);
    expect(msg2).toEqual([{ role: "assistant", content: "Done" }]);
  });

  test("tool_call without preceding text produces assistant Message with null content", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        output: "file.txt",
      },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Here" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messageIds = findMessages(g);
    expect(messageIds.length).toBe(2);

    const msg1 = deriveMessageContent(g, messageIds[0]!);
    expect(msg1).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "file.txt" },
    ]);
  });

  test("tool output is serialized to string when not a string", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "read",
        input: { path: "/a" },
      },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "read",
        output: { lines: ["a", "b"] },
      },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "." },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messageIds = findMessages(g);
    const msg = deriveMessageContent(g, messageIds[0]!);
    expect(msg[1]).toEqual({
      role: "tool",
      tool_call_id: "tc1",
      content: JSON.stringify({ lines: ["a", "b"] }),
    });
  });

  test("structural blocks (reasoning, error, relay) are skipped in Message output", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "reasoning", id: "th1", runId: "r1", agentId: "a1", content: "Hmm" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Answer" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const messageIds = findMessages(g);
    const msg = deriveMessageContent(g, messageIds[0]!);
    // Only text included, reasoning skipped
    expect(msg).toEqual([{ role: "assistant", content: "Answer" }]);
  });

  test("empty message returns empty array", () => {
    const g = buildGraph([]);
    const result = deriveMessageContent(g, "msg:nonexistent");
    expect(result).toEqual([]);
  });
});
