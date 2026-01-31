import { z } from "zod";
import type { Server } from "bun";
import type { ToolDefinition } from "../../types";
import {
  createDeterministicHarness,
  type DeterministicHarnessConfig,
} from "../../harness/providers/deterministic";
import { createAgentHarness } from "../../harness/agent";
import { createApp } from "../../../../server/index";
import type { ViewNode } from "../projections/thread";

export function collectAllViewNodes(nodes: ViewNode[]): ViewNode[] {
  const all: ViewNode[] = [];
  function walk(list: ViewNode[]) {
    for (const n of list) {
      all.push(n);
      for (const branch of n.branches) walk(branch);
    }
  }
  walk(nodes);
  return all;
}

export function startTestServer(
  config: DeterministicHarnessConfig,
  tools?: ToolDefinition[],
): { server: Server<unknown>; baseUrl: string } {
  const provider = createDeterministicHarness(config);
  const harness = createAgentHarness({ harness: provider });
  const app = createApp({ harness, tools });
  const server = Bun.serve({ fetch: app.fetch, port: 0 });
  return { server, baseUrl: `http://localhost:${server.port}` };
}

export const echoSchema = z.object({ message: z.string() });

export const echoTool: ToolDefinition<typeof echoSchema, string> = {
  name: "echo",
  description: "Echoes a message back.",
  schema: echoSchema,
  execute: async ({ message }) => ({
    context: `Echo: ${message}`,
    result: message,
  }),
};

export const renderableKinds = new Set([
  "text",
  "reasoning",
  "tool_call",
  "user",
  "error",
  "relay",
  "pending",
]);
