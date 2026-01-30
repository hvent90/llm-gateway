/**
 * Test for nested subagent scenarios (subagent spawning another subagent).
 * Verifies that:
 * 1. All events stream through correctly
 * 2. Graph structure has correct parent-child relationships
 * 3. All content nodes are reachable via projectThread
 * 4. No infinite loops or deadlocks
 */
import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import type { Server } from "bun";
import type { ToolDefinition } from "../../types";
import type { ServerEvent } from "../server-event";
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
  projectThread,
} from "../index";
import type { ViewNode } from "../index";

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

// Collect all ViewNode text content recursively
function collectTexts(nodes: ViewNode[]): string[] {
  const texts: string[] = [];
  const walk = (list: ViewNode[]) => {
    for (const node of list) {
      if (node.content.kind === "text" || node.content.kind === "user") {
        texts.push(node.content.text);
      } else if (node.content.kind === "tool_call") {
        texts.push(`[tool] ${node.content.name}`);
      }
      for (const branch of node.branches) {
        walk(branch);
      }
    }
  };
  walk(nodes);
  return texts;
}

// Count all ViewNodes recursively
function countNodes(nodes: ViewNode[]): number {
  let count = 0;
  const walk = (list: ViewNode[]) => {
    for (const node of list) {
      count++;
      for (const branch of node.branches) {
        walk(branch);
      }
    }
  };
  walk(nodes);
  return count;
}

describe("Nested Subagent Integration", () => {
  test(
    "nested subagent (A -> B -> C): all content reachable via projectThread",
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

      // Use projectThread to get the view
      const view = projectThread(state.graph);

      // Should have some content
      expect(view.length).toBeGreaterThan(0);

      // Collect all texts - should contain content from all three agents
      const texts = collectTexts(view);
      expect(texts.some((t) => t.includes("hello from C"))).toBe(true);
      expect(texts.some((t) => t.includes("B got C's result"))).toBe(true);
      expect(texts.some((t) => t.includes("A got B's result"))).toBe(true);
      // Should have tool_call nodes
      expect(texts.some((t) => t.includes("[tool] agent"))).toBe(true);

      // All projected nodes should have a valid status
      const walk = (list: ViewNode[]) => {
        for (const node of list) {
          expect(["streaming", "complete", "error"]).toContain(node.status);
          for (const branch of node.branches) {
            walk(branch);
          }
        }
      };
      walk(view);
    },
    { timeout: 30000 },
  );
});
