/**
 * Reproduction test for potential infinite loop / quadratic blowup
 * when processing nested subagent events.
 *
 * Simulates the EXACT server event sequence for A → B → C,
 * then after each event replays the UI traversal pattern
 * (getRoots + getChildren) and counts total selector calls.
 *
 * Checks:
 * 1. getChildren call count does not grow quadratically/exponentially
 * 2. No node appears as a child of two different parents (shared ownership)
 */
import { describe, test, expect } from "bun:test";
import {
  createInitialConversation,
  reduceConversation,
  getRoots,
  getChildren,
  getContentBlocks,
} from "../index";
import type { ConversationEvent } from "../conversation";

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

  /**
   * Simulate the exact React render tree traversal from MessageNode +
   * ToolCallBlock. Returns the total getChildren call count and a map
   * tracking which parent each child was found under.
   */
  function simulateUITraversal(graph: ReturnType<typeof getRoots extends (g: infer G) => unknown ? () => G : never> extends () => infer G ? G : never) {
    let getChildrenCalls = 0;
    // childId -> parentId that found it
    const childOwnership = new Map<string, string>();
    const duplicateChildren: Array<{ childId: string; parent1: string; parent2: string }> = [];

    function simulateToolCallBlock(blockId: string, depth: number) {
      getChildrenCalls++;
      const blockChildren = getChildren(graph, blockId);
      for (const childId of blockChildren) {
        const existingParent = childOwnership.get(childId);
        if (existingParent && existingParent !== blockId) {
          duplicateChildren.push({ childId, parent1: existingParent, parent2: blockId });
        }
        childOwnership.set(childId, blockId);
        simulateMessageNode(childId, depth + 1);
      }
    }

    function simulateMessageNode(runId: string, depth: number) {
      // MessageNode calls getContentBlocks, then for each tool_call block
      // renders ToolCallBlock which calls getChildren(graph, block.id)
      const blocks = getContentBlocks(graph, runId);
      for (const block of blocks) {
        if (block.type === "tool_call") {
          simulateToolCallBlock(block.id, depth);
        }
      }

      // MessageNode ALSO calls getChildren(graph, runId) at the end
      // to render nested MessageNode children
      getChildrenCalls++;
      const children = getChildren(graph, runId);
      for (const childId of children) {
        const existingParent = childOwnership.get(childId);
        if (existingParent && existingParent !== runId) {
          duplicateChildren.push({ childId, parent1: existingParent, parent2: runId });
        }
        childOwnership.set(childId, runId);
        simulateMessageNode(childId, depth + 1);
      }
    }

    const roots = getRoots(graph);
    for (const runId of roots) {
      simulateMessageNode(runId, 0);
    }

    return { getChildrenCalls, childOwnership, duplicateChildren, roots };
  }

  test("getChildren call count grows linearly, not quadratically", () => {
    let state = createInitialConversation();
    const callCountsPerEvent: number[] = [];

    for (const event of events) {
      state = reduceConversation(state, event);
      const { getChildrenCalls } = simulateUITraversal(state.graph);
      callCountsPerEvent.push(getChildrenCalls);
    }

    // Print the growth pattern for diagnosis
    console.log("getChildren calls after each event:");
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const label = evt.type === "stream_start" || evt.type === "stream_end"
        ? evt.type
        : `${evt.type}${"runId" in evt ? `(${evt.runId})` : ""}`;
      console.log(`  [${i}] ${label}: ${callCountsPerEvent[i]} calls`);
    }

    // For a tree with 3 agents, each having 1 tool call,
    // a full UI traversal should make at most:
    //   - 1 call per MessageNode (getChildren on runId) = 3
    //   - 1 call per ToolCallBlock (getChildren on block.id) = 2
    //   Total = 5 for the final state
    //
    // If it grows quadratically, the final count would be >> 5.
    // With N=3 agents, quadratic would be ~9-15, exponential would be ~8+.
    const finalCount = callCountsPerEvent[callCountsPerEvent.length - 1];
    console.log(`\nFinal getChildren call count: ${finalCount}`);

    // At most 2 calls per node (one from MessageNode, one from ToolCallBlock)
    // plus the root traversal. 3 nodes => at most ~8 calls is reasonable.
    // Anything > 20 indicates a problem.
    expect(finalCount).toBeLessThanOrEqual(20);

    // Verify that the growth is at most linear:
    // The max call count should not exceed 4 * number_of_events
    // (generous bound for linear growth)
    const maxCalls = Math.max(...callCountsPerEvent);
    expect(maxCalls).toBeLessThanOrEqual(4 * events.length);
  });

  test("no node appears as child of two different parents", () => {
    let state = createInitialConversation();

    // Process all events
    for (const event of events) {
      state = reduceConversation(state, event);
    }

    const { duplicateChildren, childOwnership } = simulateUITraversal(state.graph);

    if (duplicateChildren.length > 0) {
      console.log("DUPLICATE CHILDREN FOUND:");
      for (const dup of duplicateChildren) {
        console.log(`  Node ${dup.childId} is child of both ${dup.parent1} and ${dup.parent2}`);
      }
    }

    console.log("\nChild ownership map:");
    for (const [childId, parentId] of childOwnership) {
      console.log(`  ${childId} -> parent: ${parentId}`);
    }

    expect(duplicateChildren).toEqual([]);
  });

  test("all graph nodes are reachable via UI traversal", () => {
    let state = createInitialConversation();

    for (const event of events) {
      state = reduceConversation(state, event);
    }

    const { childOwnership, roots } = simulateUITraversal(state.graph);

    // All reachable = roots + all children
    const reachable = new Set([...roots, ...childOwnership.keys()]);

    const unreachable: string[] = [];
    for (const [runId] of state.graph.nodes) {
      if (!reachable.has(runId)) {
        unreachable.push(runId);
      }
    }

    if (unreachable.length > 0) {
      console.log("UNREACHABLE NODES:");
      for (const runId of unreachable) {
        const node = state.graph.nodes.get(runId)!;
        console.log(`  ${runId} (parentId=${node.parentId})`);
      }
      console.log("\nAll graph nodes:");
      for (const [runId, node] of state.graph.nodes) {
        console.log(`  ${runId} (parentId=${node.parentId})`);
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

    const { getChildrenCalls, duplicateChildren } = simulateUITraversal(state.graph);

    console.log(`\nDeep chain (${N} agents):`);
    console.log(`  Total getChildren calls: ${getChildrenCalls}`);
    console.log(`  Graph nodes: ${state.graph.nodes.size}`);

    // For a linear chain of N agents, each with 1 tool call (except leaf),
    // the UI traversal should make:
    //   - N calls from MessageNode (one per agent)
    //   - (N-1) calls from ToolCallBlock (one per tool_call)
    //   = 2N - 1 calls total
    // If exponential, it would be 2^N or similar.
    const expectedLinear = 2 * N - 1;
    console.log(`  Expected ~${expectedLinear} calls for linear growth`);

    // Allow some slack but catch exponential blowup
    expect(getChildrenCalls).toBeLessThanOrEqual(expectedLinear * 3);
    expect(duplicateChildren).toEqual([]);
  });

  test("colliding provider-issued tool_call IDs do not cause infinite loop or duplicate children", () => {
    // Reproduce the exact bug: two agents both produce tool_calls with
    // the same raw ID "functions.agent:0" (as Kimi does). After namespacing
    // in agent.ts, these should be globally unique and not collide.
    //
    // Before the fix, getChildren(graph, "functions.agent:0") would find
    // agent B (whose parentId is "functions.agent:0") when rendering
    // agent A's tool_call block, creating an infinite render loop.
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

    const { duplicateChildren, getChildrenCalls } = simulateUITraversal(state.graph);

    // No node should appear as child of two different parents
    expect(duplicateChildren).toEqual([]);

    // Should not blow up — 3 agents with 2 tool calls = at most ~5 getChildren calls
    expect(getChildrenCalls).toBeLessThanOrEqual(10);

    // Verify correct parent-child structure:
    // A's tool_call "a/functions.agent:0" should have B as child
    // B's tool_call "b/functions.agent:0" should have C as child
    const aChildren = getChildren(state.graph, "a/functions.agent:0");
    expect(aChildren).toEqual(["b"]);

    const bChildren = getChildren(state.graph, "b/functions.agent:0");
    expect(bChildren).toEqual(["c"]);

    // C has no tool calls, no children
    const cChildren = getChildren(state.graph, "c");
    expect(cChildren).toEqual([]);
  });
});
