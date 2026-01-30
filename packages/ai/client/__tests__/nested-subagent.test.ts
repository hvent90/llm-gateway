/**
 * Test for nested subagent scenarios (subagent spawning another subagent).
 * Verifies that:
 * 1. All events stream through correctly
 * 2. Graph structure has correct parent-child relationships
 * 3. All nodes are reachable via projectThread (no orphans)
 * 4. No infinite loops or deadlocks
 */
import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import type { Server } from "bun";
import type { ToolDefinition } from "../../types";
import type { ServerEvent } from "../server-event";
import {
  createSSETransport,
  createInitialConversation,
  reduceConversation,
  projectThread,
} from "../index";
import { collectAllViewNodes, startTestServer, renderableKinds } from "./helpers";

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
    "nested subagent (A → B → C): all nodes reachable via projectThread",
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

      // Use projectThread to verify all content-bearing nodes are reachable
      const viewNodes = projectThread(state.graph);
      const all = collectAllViewNodes(viewNodes);
      const projectedIds = new Set(all.map((n) => n.id));

      // Every renderable node in the graph must appear in the projection
      const unreachable: string[] = [];
      for (const [, node] of state.graph.nodes) {
        if (renderableKinds.has(node.kind) && !projectedIds.has(node.id)) {
          unreachable.push(node.id);
        }
      }

      expect(unreachable).toEqual([]);

      // Verify specific text content appears
      const allTexts = all
        .filter((n) => n.content.kind === "text")
        .map((n) => (n.content as { kind: "text"; text: string }).text);

      expect(allTexts.some((t) => t.includes("hello from C"))).toBe(true);
      expect(allTexts.some((t) => t.includes("B got C's result"))).toBe(true);
      expect(allTexts.some((t) => t.includes("A got B's result"))).toBe(true);

      // Verify tool_call ViewNodes exist
      const toolCalls = all.filter((n) => n.content.kind === "tool_call");
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 30000 },
  );
});
