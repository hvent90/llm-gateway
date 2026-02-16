import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, type GraphEvent } from "../../reducer";
import { projectMessages } from "../../projections/messages";
import type { ContentPart } from "../../../../types";

function buildGraph(events: GraphEvent[]) {
  let g = createGraph();
  for (const e of events) g = reduceEvent(g, e);
  return g;
}

describe("Messages Projection", () => {
  test("empty graph → []", () => {
    expect(projectMessages(createGraph())).toEqual([]);
  });

  test("user message only → [{ role: 'user', content }]", () => {
    const g = buildGraph([{ type: "user", runId: "u1", content: "Hello" }]);
    expect(projectMessages(g)).toEqual([{ role: "user", content: "Hello" }]);
  });

  test("user + text → user message + assistant message", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Hello" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      {
        type: "text",
        id: "t1",
        runId: "r1",
        agentId: "a1",
        parentId: "u1:user",
        content: "Hi there",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    expect(projectMessages(g)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there", tool_calls: undefined },
    ]);
  });

  test("user + text + tool_call + text → correct message sequence", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "Run ls" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", parentId: "u1:user", content: "Sure" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { command: "ls" },
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
    const msgs = projectMessages(g);
    expect(msgs).toEqual([
      { role: "user", content: "Run ls" },
      {
        role: "assistant",
        content: "Sure",
        tool_calls: [{ id: "tc1", name: "bash", arguments: { command: "ls" } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "file.txt" },
      { role: "assistant", content: "Done", tool_calls: undefined },
    ]);
  });

  test("multiple tool_calls in same turn → single assistant msg with multiple tool_calls", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "read",
        input: { path: "a.ts" },
      },
      {
        type: "tool_result",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "read",
        output: "content-a",
      },
      {
        type: "tool_call",
        id: "tc2",
        runId: "r1",
        agentId: "a1",
        name: "read",
        input: { path: "b.ts" },
      },
      {
        type: "tool_result",
        id: "tc2",
        runId: "r1",
        agentId: "a1",
        name: "read",
        output: "content-b",
      },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const msgs = projectMessages(g);
    expect(msgs).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", name: "read", arguments: { path: "a.ts" } },
          { id: "tc2", name: "read", arguments: { path: "b.ts" } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", content: "content-a" },
      { role: "tool", tool_call_id: "tc2", content: "content-b" },
    ]);
  });

  test("tool call with no output (streaming) → assistant msg with tool_calls, no tool msg", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      {
        type: "tool_call",
        id: "tc1",
        runId: "r1",
        agentId: "a1",
        name: "bash",
        input: { command: "ls" },
      },
      // No tool_result yet — still streaming
    ]);
    const msgs = projectMessages(g);
    expect(msgs).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", name: "bash", arguments: { command: "ls" } }],
      },
    ]);
  });

  test("user with ContentPart[] → user message with structured content", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Check this" },
      { type: "image", mediaType: "image/png", data: "base64data" },
    ];
    const g = buildGraph([{ type: "user", runId: "u1", content: parts }]);
    const msgs = projectMessages(g);
    expect(msgs).toEqual([{ role: "user", content: parts }]);
  });

  test("reasoning nodes → skipped", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "a1" },
      { type: "reasoning", id: "r1x", runId: "r1", agentId: "a1", content: "Hmm let me think" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", content: "Answer" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
    ]);
    const msgs = projectMessages(g);
    expect(msgs).toEqual([{ role: "assistant", content: "Answer", tool_calls: undefined }]);
  });

  test("subagent branch → skipped (only main thread in output)", () => {
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
    const msgs = projectMessages(g);
    // Subagent text "Found it" should NOT appear in messages
    expect(
      msgs.some((m) => m.role === "assistant" && "content" in m && m.content === "Found it"),
    ).toBe(false);
    // Main thread content should be present
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: "Searching",
      tool_calls: [{ id: "tc1", name: "search", arguments: "auth" }],
    });
    expect(msgs[1]).toEqual({ role: "tool", tool_call_id: "tc1", content: '["auth.ts"]' });
    expect(msgs[2]).toEqual({ role: "assistant", content: "Done", tool_calls: undefined });
  });

  test("multi-turn conversation → correct message ordering", () => {
    const g = buildGraph([
      { type: "user", runId: "u1", content: "What is 2+2?" },
      { type: "harness_start", runId: "r1", agentId: "a1", parentId: "u1:user" },
      { type: "text", id: "t1", runId: "r1", agentId: "a1", parentId: "u1:user", content: "4" },
      { type: "harness_end", runId: "r1", agentId: "a1" },
      { type: "user", runId: "u2", content: "And 3+3?" },
      { type: "harness_start", runId: "r2", agentId: "a2", parentId: "u2:user" },
      { type: "text", id: "t2", runId: "r2", agentId: "a2", parentId: "u2:user", content: "6" },
      { type: "harness_end", runId: "r2", agentId: "a2" },
    ]);
    const msgs = projectMessages(g);
    expect(msgs).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4", tool_calls: undefined },
      { role: "user", content: "And 3+3?" },
      { role: "assistant", content: "6", tool_calls: undefined },
    ]);
  });
});
