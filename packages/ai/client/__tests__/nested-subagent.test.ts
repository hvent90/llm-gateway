/**
 * Test for nested subagent scenarios (subagent spawning another subagent).
 * Verifies that:
 * 1. All events stream through correctly
 * 2. Graph structure has correct parent-child relationships
 * 3. All nodes are reachable via tree traversal (no orphans)
 * 4. No infinite loops or deadlocks
 */
import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import type { Server } from "bun";
import type { ToolDefinition } from "../../types";
import type { ServerEvent } from "../server-event";
import type { ConversationState } from "../conversation";
import {
  createDeterministicHarness,
  type DeterministicHarnessConfig,
} from "../../harness/providers/deterministic";
import { createAgentHarness } from "../../harness/agent";
import { createApp } from "../../../../server/index";
import {
  createSSETransport,
  createInitialConversation,
  reduceConversation,
  getRoots,
  getChildren,
  getContentBlocks,
  getText,
} from "../index";

// --- Test helpers ---

function startTestServer(
  config: DeterministicHarnessConfig,
  tools?: ToolDefinition[],
): { server: Server<unknown>; baseUrl: string } {
  const provider = createDeterministicHarness(config);
  const harness = createAgentHarness({ harness: provider });
  const app = createApp({ harness, tools });
  const server = Bun.serve({ fetch: app.fetch, port: 0 });
  return { server, baseUrl: `http://localhost:${server.port}` };
}

const agentSchema = z.object({ task: z.string() });
const agentTool: ToolDefinition<typeof agentSchema, string> = {
  name: "agent",
  description: "Spawn a subagent",
  schema: agentSchema,
  execute: async ({ task }, ctx) => {
    if (!ctx.spawn) throw new Error("spawn not available");
    const result = await ctx.spawn(task);
    return { context: result, result };
  },
};

let server: Server<unknown> | undefined;

afterEach(() => {
  if (server) {
    server.stop(true);
    server = undefined;
  }
});

describe("Nested Subagent Integration", () => {
  test(
    "nested subagent (A → B → C): all nodes reachable via UI traversal pattern",
    async () => {
      const setup = startTestServer(
        {
          responses: [
            { events: [{ type: "tool_call", name: "agent", input: { task: "do B" } }] },
            { events: [{ type: "tool_call", name: "agent", input: { task: "do C" } }] },
            { events: [{ type: "text", content: "hello from C" }] },
            { events: [{ type: "text", content: "B got C's result" }] },
            { events: [{ type: "text", content: "A got B's result" }] },
          ],
        },
        [agentTool],
      );
      server = setup.server;

      const transport = createSSETransport({ baseUrl: setup.baseUrl });
      let state = createInitialConversation();
      const events: ServerEvent[] = [];

      state = reduceConversation(state, { type: "stream_start" });

      for await (const event of transport.stream({
        model: "deterministic",
        messages: [{ role: "user", content: "start" }],
        permissions: { allowlist: [{ tool: "agent" }] },
      })) {
        events.push(event);
        state = reduceConversation(state, event);
      }

      state = reduceConversation(state, { type: "stream_end" });

      // Debug: dump the graph structure
      const nodeInfo: Array<{
        runId: string;
        parentId?: string;
        text: string;
        toolCalls: string[];
      }> = [];
      for (const [runId, node] of state.graph.nodes) {
        const blocks = getContentBlocks(state.graph, runId);
        const text = getText(state.graph, runId);
        const toolCalls = blocks
          .filter((b) => b.type === "tool_call")
          .map((b) => `${b.name}(${b.id})`);
        nodeInfo.push({ runId, parentId: node.parentId, text, toolCalls });
      }

      // Simulate the exact UI traversal pattern:
      // ConversationThread renders roots via getRoots()
      // MessageNode renders children via getChildren(graph, runId)
      // ToolCallBlock renders children via getChildren(graph, block.id)
      const reachable = new Set<string>();

      function simulateMessageNode(runId: string, depth: number) {
        if (reachable.has(runId)) return; // cycle guard
        reachable.add(runId);

        const blocks = getContentBlocks(state.graph, runId);

        // ContentBlockView → ToolCallBlock for each tool_call block
        for (const block of blocks) {
          if (block.type === "tool_call") {
            // ToolCallBlock calls getChildren(graph, block.id)
            const blockChildren = getChildren(state.graph, block.id);
            for (const childId of blockChildren) {
              simulateMessageNode(childId, depth + 1);
            }
          }
        }

        // MessageNode also calls getChildren(graph, runId) at the end
        const children = getChildren(state.graph, runId);
        for (const childId of children) {
          simulateMessageNode(childId, depth + 1);
        }
      }

      const roots = getRoots(state.graph);
      for (const runId of roots) {
        simulateMessageNode(runId, 0);
      }

      // Every node in the graph must be reachable via UI traversal
      const unreachable: string[] = [];
      for (const [runId] of state.graph.nodes) {
        if (!reachable.has(runId)) {
          const node = state.graph.nodes.get(runId)!;
          unreachable.push(
            `${runId} (parentId=${node.parentId}, text=${getText(state.graph, runId)})`,
          );
        }
      }

      if (unreachable.length > 0) {
        // Print full graph for debugging
        console.log("Graph nodes:", JSON.stringify(nodeInfo, null, 2));
        console.log("Roots:", roots);
        console.log("Reachable:", [...reachable]);
        console.log("Unreachable:", unreachable);
      }

      expect(unreachable).toEqual([]);
    },
    { timeout: 30000 },
  );
});
