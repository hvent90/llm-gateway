/**
 * Tests for the thread projection of nested subagent event sequences.
 *
 * Verifies that:
 * 1. projectThread produces correct output for A → B → C
 * 2. No duplicate ViewNode ids in flattened output
 * 3. All content-bearing graph nodes are reachable via projectThread
 * 4. Increasing nesting depth does not cause exponential blowup
 * 5. Colliding provider-issued tool_call IDs produce correct structure
 */
import { describe, test, expect } from "bun:test";
import { createInitialConversation, reduceConversation, projectThread } from "../index";
import type { ConversationEvent } from "../conversation";
import { collectAllViewNodes, renderableKinds } from "./helpers";

describe("Nested subagent render count", () => {
  // Full event sequence for A → B → C
  const events: ConversationEvent[] = [
    { type: "stream_start" },
    // Agent A starts (root)
    {
      type: "harness_start",
      runId: "a",
      agentId: "a",
    },
    // A produces some text
    {
      type: "text",
      id: "text-a-1",
      runId: "a",
      agentId: "a",
      content: "Hello from A",
    },
    // A calls tool "agent" to spawn B
    {
      type: "tool_call",
      id: "tc-a-1",
      runId: "a",
      agentId: "a",
      name: "agent",
      input: { task: "do B" },
    },
    // B starts as child of tool call tc-a-1
    {
      type: "harness_start",
      runId: "b",
      agentId: "b",
      parentId: "tc-a-1",
    },
    // B produces text
    {
      type: "text",
      id: "text-b-1",
      runId: "b",
      agentId: "b",
      parentId: "tc-a-1",
      content: "Hello from B",
    },
    // B calls tool "agent" to spawn C
    {
      type: "tool_call",
      id: "tc-b-1",
      runId: "b",
      agentId: "b",
      parentId: "tc-a-1",
      name: "agent",
      input: { task: "do C" },
    },
    // C starts as child of tool call tc-b-1
    {
      type: "harness_start",
      runId: "c",
      agentId: "c",
      parentId: "tc-b-1",
    },
    // C produces text
    {
      type: "text",
      id: "text-c-1",
      runId: "c",
      agentId: "c",
      parentId: "tc-b-1",
      content: "Hello from C",
    },
    // C ends
    {
      type: "harness_end",
      runId: "c",
      agentId: "c",
      parentId: "tc-b-1",
    },
    // B gets tool result for C
    {
      type: "tool_result",
      id: "tc-b-1",
      runId: "b",
      agentId: "b",
      parentId: "tc-a-1",
      name: "agent",
      output: "C result",
    },
    // B ends
    {
      type: "harness_end",
      runId: "b",
      agentId: "b",
      parentId: "tc-a-1",
    },
    // A gets tool result for B
    {
      type: "tool_result",
      id: "tc-a-1",
      runId: "a",
      agentId: "a",
      name: "agent",
      output: "B result",
    },
    // A ends
    {
      type: "harness_end",
      runId: "a",
      agentId: "a",
    },
    { type: "stream_end" },
  ];

  test("projectThread produces correct output at each step", () => {
    let state = createInitialConversation();

    for (const event of events) {
      state = reduceConversation(state, event);
      // projectThread should not throw at any intermediate state
      const viewNodes = projectThread(state.graph);
      expect(Array.isArray(viewNodes)).toBe(true);
    }

    // Final state: verify the ViewNode tree has correct content
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);

    // Should contain text from all three agents
    const texts = all
      .filter((n) => n.content.kind === "text")
      .map((n) => (n.content as { kind: "text"; text: string }).text);
    expect(texts.some((t) => t.includes("Hello from A"))).toBe(true);
    expect(texts.some((t) => t.includes("Hello from B"))).toBe(true);
    expect(texts.some((t) => t.includes("Hello from C"))).toBe(true);

    // Should contain tool_call ViewNodes
    const toolCalls = all.filter((n) => n.content.kind === "tool_call");
    expect(toolCalls.length).toBe(2);
  });

  test("no duplicate ViewNode ids in the flattened output", () => {
    let state = createInitialConversation();

    // Process all events
    for (const event of events) {
      state = reduceConversation(state, event);
    }

    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const ids = all.map((n) => n.id);
    const uniqueIds = new Set(ids);

    expect(ids.length).toBe(uniqueIds.size);
  });

  test("all content-bearing graph nodes are reachable via projectThread", () => {
    let state = createInitialConversation();

    for (const event of events) {
      state = reduceConversation(state, event);
    }

    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const projectedIds = new Set(all.map((n) => n.id));

    const unreachable: string[] = [];
    for (const [, node] of state.graph.nodes) {
      if (renderableKinds.has(node.kind) && !projectedIds.has(node.id)) {
        unreachable.push(node.id);
      }
    }

    expect(unreachable).toEqual([]);
  });

  test("increasing nesting depth does not cause exponential blowup", () => {
    // Build a chain of N agents: A0 -> A1 -> A2 -> ... -> A(N-1)
    const N = 10;

    function buildDeepChain(depth: number): ConversationEvent[] {
      const evts: ConversationEvent[] = [{ type: "stream_start" }];

      // harness_start for each agent
      for (let i = 0; i < depth; i++) {
        const runId = `agent-${i}`;
        const agentId = runId;
        const parentId = i === 0 ? undefined : `tc-${i - 1}`;

        evts.push({
          type: "harness_start",
          runId,
          agentId,
          ...(parentId ? { parentId } : {}),
        } as ConversationEvent);

        evts.push({
          type: "text",
          id: `text-${i}`,
          runId,
          agentId,
          ...(parentId ? { parentId } : {}),
          content: `text from agent ${i}`,
        } as ConversationEvent);

        if (i < depth - 1) {
          evts.push({
            type: "tool_call",
            id: `tc-${i}`,
            runId,
            agentId,
            ...(parentId ? { parentId } : {}),
            name: "agent",
            input: { task: `spawn agent ${i + 1}` },
          } as ConversationEvent);
        }
      }

      // harness_end + tool_result in reverse order
      for (let i = depth - 1; i >= 0; i--) {
        const runId = `agent-${i}`;
        const agentId = runId;
        const parentId = i === 0 ? undefined : `tc-${i - 1}`;

        evts.push({
          type: "harness_end",
          runId,
          agentId,
          ...(parentId ? { parentId } : {}),
        } as ConversationEvent);

        if (i > 0) {
          // tool_result goes to the PARENT agent
          const parentRunId = `agent-${i - 1}`;
          const parentParentId = i === 1 ? undefined : `tc-${i - 2}`;
          evts.push({
            type: "tool_result",
            id: `tc-${i - 1}`,
            runId: parentRunId,
            agentId: parentRunId,
            ...(parentParentId ? { parentId: parentParentId } : {}),
            name: "agent",
            output: `result from agent ${i}`,
          } as ConversationEvent);
        }
      }

      evts.push({ type: "stream_end" });
      return evts;
    }

    const deepEvents = buildDeepChain(N);
    let state = createInitialConversation();

    for (const event of deepEvents) {
      state = reduceConversation(state, event);
    }

    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);

    // Should have N text ViewNodes (one per agent)
    const textNodes = all.filter((n) => n.content.kind === "text");
    expect(textNodes.length).toBe(N);

    // Should have N-1 tool_call ViewNodes
    const toolCallNodes = all.filter((n) => n.content.kind === "tool_call");
    expect(toolCallNodes.length).toBe(N - 1);

    // Total renderable ViewNodes = N text + (N-1) tool_call = 2N - 1
    const renderableNodes = all.filter(
      (n) => n.content.kind === "text" || n.content.kind === "tool_call",
    );
    expect(renderableNodes.length).toBe(2 * N - 1);

    // No duplicates
    const ids = all.map((n) => n.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("colliding provider-issued tool_call IDs produce correct nesting structure", () => {
    const collidingEvents: ConversationEvent[] = [
      { type: "stream_start" },
      // Agent A starts
      {
        type: "harness_start",
        runId: "a",
        agentId: "a",
      },
      // A calls tool "agent" — provider gives ID "functions.agent:0"
      // After nsId: this becomes "a/functions.agent:0"
      {
        type: "tool_call",
        id: "a/functions.agent:0",
        runId: "a",
        agentId: "a",
        name: "agent",
        input: { task: "do B" },
      },
      // B starts as child of A's namespaced tool call
      {
        type: "harness_start",
        runId: "b",
        agentId: "b",
        parentId: "a/functions.agent:0",
      },
      // B calls tool "agent" — provider also gives ID "functions.agent:0"
      // After nsId: this becomes "b/functions.agent:0"
      {
        type: "tool_call",
        id: "b/functions.agent:0",
        runId: "b",
        agentId: "b",
        parentId: "a/functions.agent:0",
        name: "agent",
        input: { task: "do C" },
      },
      // C starts as child of B's namespaced tool call
      {
        type: "harness_start",
        runId: "c",
        agentId: "c",
        parentId: "b/functions.agent:0",
      },
      // C produces text
      {
        type: "text",
        id: "text-c-1",
        runId: "c",
        agentId: "c",
        parentId: "b/functions.agent:0",
        content: "Hello from C",
      },
      // C ends
      {
        type: "harness_end",
        runId: "c",
        agentId: "c",
        parentId: "b/functions.agent:0",
      },
      // B gets tool result
      {
        type: "tool_result",
        id: "b/functions.agent:0",
        runId: "b",
        agentId: "b",
        parentId: "a/functions.agent:0",
        name: "agent",
        output: "C result",
      },
      // B ends
      {
        type: "harness_end",
        runId: "b",
        agentId: "b",
        parentId: "a/functions.agent:0",
      },
      // A gets tool result
      {
        type: "tool_result",
        id: "a/functions.agent:0",
        runId: "a",
        agentId: "a",
        name: "agent",
        output: "B result",
      },
      // A ends
      {
        type: "harness_end",
        runId: "a",
        agentId: "a",
      },
      { type: "stream_end" },
    ];

    let state = createInitialConversation();
    for (const event of collidingEvents) {
      state = reduceConversation(state, event);
    }

    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);

    // No duplicate ids
    const ids = all.map((n) => n.id);
    expect(ids.length).toBe(new Set(ids).size);

    // Verify correct nesting via branches:
    // Agent A's tool_call should have B's content as a branch
    const aToolCall = all.find(
      (n) => n.content.kind === "tool_call" && n.id === "a/functions.agent:0",
    );
    expect(aToolCall).toBeDefined();
    expect(aToolCall!.branches.length).toBeGreaterThan(0);

    // B's content should appear in A's tool_call branches
    const aBranchNodes = aToolCall!.branches.flatMap((branch) => collectAllViewNodes(branch));
    const bToolCall = aBranchNodes.find(
      (n) => n.content.kind === "tool_call" && n.id === "b/functions.agent:0",
    );
    expect(bToolCall).toBeDefined();

    // B's tool_call should have C's content as a branch
    expect(bToolCall!.branches.length).toBeGreaterThan(0);
    const bBranchNodes = bToolCall!.branches.flatMap((branch) => collectAllViewNodes(branch));
    const cText = bBranchNodes.find(
      (n) =>
        n.content.kind === "text" &&
        (n.content as { kind: "text"; text: string }).text === "Hello from C",
    );
    expect(cText).toBeDefined();
  });
});
