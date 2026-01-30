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
  createHTTPTransport,
  createInitialConversation,
  reduceConversation,
  projectThread,
} from "../index";
import type { ViewNode } from "../index";

// --- Test tool ---

const echoSchema = z.object({ message: z.string() });

const echoTool: ToolDefinition<typeof echoSchema, string> = {
  name: "echo",
  description: "Echoes a message back.",
  schema: echoSchema,
  execute: async ({ message }) => ({
    context: `Echo: ${message}`,
    result: message,
  }),
};

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

/**
 * Stream a chat request and reduce all SSE events into conversation state.
 * Returns final state and collected server events.
 */
async function streamToState(
  baseUrl: string,
  messages: Array<{ role: string; content: string }>,
  permissions?: { allowlist?: Array<{ tool: string }> },
): Promise<{ state: ConversationState; events: ServerEvent[] }> {
  const transport = createSSETransport({ baseUrl });
  let state = createInitialConversation();
  const events: ServerEvent[] = [];

  state = reduceConversation(state, { type: "stream_start" });

  for await (const event of transport.stream({
    model: "deterministic",
    messages,
    ...(permissions && { permissions }),
  })) {
    events.push(event);
    state = reduceConversation(state, event);
  }

  state = reduceConversation(state, { type: "stream_end" });
  return { state, events };
}

// --- ViewNode helpers ---

function collectTexts(nodes: ViewNode[]): string[] {
  const texts: string[] = [];
  const walk = (list: ViewNode[]) => {
    for (const node of list) {
      if (node.content.kind === "text" || node.content.kind === "user") {
        texts.push(node.content.text);
      }
      for (const branch of node.branches) {
        walk(branch);
      }
    }
  };
  walk(nodes);
  return texts;
}

function findNodeByText(nodes: ViewNode[], substring: string): ViewNode | undefined {
  const walk = (list: ViewNode[]): ViewNode | undefined => {
    for (const node of list) {
      if (
        (node.content.kind === "text" || node.content.kind === "user") &&
        node.content.text.includes(substring)
      ) {
        return node;
      }
      for (const branch of node.branches) {
        const found = walk(branch);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(nodes);
}

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

// --- Tests ---

let server: Server<unknown> | undefined;

afterEach(() => {
  if (server) {
    server.stop(true);
    server = undefined;
  }
});

describe("Conversation Reducer Integration", () => {
  test("simple text response: sessionId set, assistant node with text", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "Hello world" }] }],
    });
    server = setup.server;

    const { state } = await streamToState(setup.baseUrl, [{ role: "user", content: "hi" }]);

    expect(state.sessionId).toBeDefined();
    expect(state.sessionId).not.toBeNull();

    // Should have at least one graph node
    expect(state.graph.nodes.size).toBeGreaterThan(0);

    // Find the assistant node with our text content via projectThread
    const view = projectThread(state.graph);
    const node = findNodeByText(view, "Hello world");
    expect(node).toBeDefined();
    expect(node!.role).toBe("assistant");
  });

  test("streaming text chunks merge into single text node in view", async () => {
    const setup = startTestServer({
      responses: [
        {
          events: [
            { type: "text", content: "Hello " },
            { type: "text", content: "world" },
            { type: "text", content: "!" },
          ],
        },
      ],
    });
    server = setup.server;

    const { state } = await streamToState(setup.baseUrl, [{ role: "user", content: "hi" }]);

    // projectThread merges consecutive text nodes from the same run
    const view = projectThread(state.graph);
    const texts = collectTexts(view);
    const fullText = texts.join("");
    expect(fullText).toContain("Hello world!");
  });

  test("reasoning + text: both block types present in view", async () => {
    const setup = startTestServer({
      responses: [
        {
          events: [
            { type: "reasoning", content: "Let me think about this..." },
            { type: "text", content: "Here is my answer" },
          ],
        },
      ],
    });
    server = setup.server;

    const { state } = await streamToState(setup.baseUrl, [
      { role: "user", content: "think then answer" },
    ]);

    const view = projectThread(state.graph);

    // Find reasoning and text content
    let foundReasoning = false;
    let foundText = false;
    const walk = (list: ViewNode[]) => {
      for (const node of list) {
        if (node.content.kind === "reasoning" && node.content.text.includes("think")) {
          foundReasoning = true;
        }
        if (node.content.kind === "text" && node.content.text.includes("answer")) {
          foundText = true;
        }
        for (const branch of node.branches) {
          walk(branch);
        }
      }
    };
    walk(view);

    expect(foundReasoning).toBe(true);
    expect(foundText).toBe(true);
  });

  test("tool call with auto-approve (tool in allowlist)", async () => {
    const setup = startTestServer(
      {
        responses: [
          // First iteration: model wants to call echo tool
          { events: [{ type: "tool_call", name: "echo", input: { message: "ping" } }] },
          // Second iteration: model responds with text after tool result
          { events: [{ type: "text", content: "The echo said: ping" }] },
        ],
      },
      [echoTool],
    );
    server = setup.server;

    const { state, events } = await streamToState(
      setup.baseUrl,
      [{ role: "user", content: "echo ping" }],
      { allowlist: [{ tool: "echo" }] },
    );

    // Should have tool_call, tool_result, and text events
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    const textEvents = events.filter((e) => e.type === "text");

    expect(toolCallEvents.length).toBeGreaterThan(0);
    expect(toolResultEvents.length).toBeGreaterThan(0);
    expect(textEvents.length).toBeGreaterThan(0);

    // The tool_call event should have name "echo"
    expect((toolCallEvents[0] as { name: string }).name).toBe("echo");

    // View should contain a tool_call node with output
    const view = projectThread(state.graph);
    let foundToolBlock = false;
    const walk = (list: ViewNode[]) => {
      for (const node of list) {
        if (node.content.kind === "tool_call" && node.content.name === "echo") {
          expect(node.content.output).toBeDefined();
          foundToolBlock = true;
        }
        for (const branch of node.branches) {
          walk(branch);
        }
      }
    };
    walk(view);
    expect(foundToolBlock).toBe(true);
  });

  test("tool call with relay (empty allowlist): pendingRelays populated, then resolved", async () => {
    const setup = startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "test" } }] },
          { events: [{ type: "text", content: "Done after approval" }] },
        ],
      },
      [echoTool],
    );
    server = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });

    let state = createInitialConversation();

    const streamIter = transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo test" }],
      permissions: { allowlist: [] }, // Empty = everything needs permission
    });

    const events: ServerEvent[] = [];
    for await (const event of streamIter) {
      events.push(event);
      state = reduceConversation(state, event);

      // When we hit a relay, verify pendingRelays then approve it
      if (event.type === "relay") {
        expect(state.pendingRelays.length).toBe(1);
        expect(state.pendingRelays[0]!.tool).toBe("echo");

        // Resolve relay via HTTP
        await httpTransport.resolveRelay(state.sessionId!, event.id, {
          approved: true,
        });

        // Clear pending in local state
        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: "echo",
          approved: true,
        });
      }
    }

    // After full round trip, should have tool_call and text events
    expect(events.some((e) => e.type === "relay")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(state.pendingRelays.length).toBe(0);
    expect(state.grantedTools.has("echo")).toBe(true);
  });

  test("permission denied: tool_result with denied status", async () => {
    const setup = startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "nope" } }] },
          // After denial, agent still continues -- model gets denied result and responds
          { events: [{ type: "text", content: "Tool was denied" }] },
        ],
      },
      [echoTool],
    );
    server = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });

    let state = createInitialConversation();

    const events: ServerEvent[] = [];
    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "try echo" }],
      permissions: { allowlist: [] },
    })) {
      events.push(event);
      state = reduceConversation(state, event);

      if (event.type === "relay") {
        // Deny
        await httpTransport.resolveRelay(state.sessionId!, event.id, {
          approved: false,
          reason: "User denied",
        });

        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: "echo",
          approved: false,
        });
      }
    }

    // Should have a tool_result with denied status
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    const denied = toolResults.find(
      (e) => e.type === "tool_result" && (e.output as { status?: string })?.status === "denied",
    );
    expect(denied).toBeDefined();

    // Tool should NOT be in grantedTools
    expect(state.grantedTools.has("echo")).toBe(false);
  });

  test("error from provider: error node in graph", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "error", message: "Provider exploded" }] }],
    });
    server = setup.server;

    const { state, events } = await streamToState(setup.baseUrl, [
      { role: "user", content: "fail" },
    ]);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
    expect((errorEvents[0] as { message: string }).message).toContain("Provider exploded");

    // Error node should exist in graph
    let foundError = false;
    for (const node of state.graph.nodes.values()) {
      if (node.kind === "error") foundError = true;
    }
    expect(foundError).toBe(true);
  });

  test("full round trip: user -> stream -> assistant with correct graph structure", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "I am the assistant" }] }],
    });
    server = setup.server;

    // Start with user node in state
    let state = createInitialConversation();
    const userRunId = "user-msg-1";
    state = reduceConversation(state, {
      type: "user",
      runId: userRunId,
      content: "Hello assistant",
    });

    // Stream and reduce
    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    state = reduceConversation(state, { type: "stream_start" });

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "Hello assistant" }],
    })) {
      state = reduceConversation(state, event);
    }

    state = reduceConversation(state, { type: "stream_end" });

    // Graph should have user node visible via projectThread
    const view = projectThread(state.graph);

    const userNode = findNodeByText(view, "Hello assistant");
    expect(userNode).toBeDefined();
    expect(userNode!.role).toBe("user");

    // There should be an assistant node
    const assistantNode = findNodeByText(view, "I am the assistant");
    expect(assistantNode).toBeDefined();
    expect(assistantNode!.role).toBe("assistant");

    // Stream should be inactive
    expect(state.activeStreams.size).toBe(0);
  });

  test("assistant nodes are reachable via projectThread (not orphaned)", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "Visible response" }] }],
    });
    server = setup.server;

    let state = createInitialConversation();
    state = reduceConversation(state, { type: "user", runId: "user-1", content: "Hello" });

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "Hello" }],
    })) {
      state = reduceConversation(state, event);
    }

    // projectThread should produce a non-empty view
    const view = projectThread(state.graph);
    expect(countNodes(view)).toBeGreaterThan(0);

    // The response text should be visible
    const texts = collectTexts(view);
    expect(texts.some((t) => t.includes("Visible response"))).toBe(true);
  });

  test("streamed text is visible through projectThread during streaming", async () => {
    const setup = startTestServer({
      responses: [
        {
          events: [
            { type: "text", content: "chunk1" },
            { type: "text", content: "chunk2" },
          ],
        },
      ],
    });
    server = setup.server;

    let state = createInitialConversation();
    state = reduceConversation(state, { type: "user", runId: "user-1", content: "Go" });
    state = reduceConversation(state, { type: "stream_start" });

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const snapshots: string[] = [];

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "Go" }],
    })) {
      state = reduceConversation(state, event);

      // After each event, check what text is visible via projectThread
      const view = projectThread(state.graph);
      const texts = collectTexts(view);
      snapshots.push(texts.join(""));
    }

    // Filter to only snapshots with assistant content (skip "connected" event snapshot)
    const withContent = snapshots.filter((s) => s.includes("chunk"));
    expect(withContent.length).toBeGreaterThan(0);
    // The final snapshot should contain all chunks (merged by projectThread)
    expect(withContent[withContent.length - 1]).toContain("chunk1chunk2");
  });

  test("tool call flow: all content visible via projectThread", async () => {
    const setup = startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "test" } }] },
          { events: [{ type: "text", content: "Echo result" }] },
        ],
      },
      [echoTool],
    );
    server = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo test" }],
      permissions: { allowlist: [{ tool: "echo" }] },
    })) {
      state = reduceConversation(state, event);
    }

    // All content should be visible via projectThread
    const view = projectThread(state.graph);
    const texts = collectTexts(view);
    expect(texts.some((t) => t.includes("Echo result"))).toBe(true);

    // Should have a tool_call node
    let foundToolCall = false;
    const walk = (list: ViewNode[]) => {
      for (const node of list) {
        if (node.content.kind === "tool_call" && node.content.name === "echo") {
          foundToolCall = true;
        }
        for (const branch of node.branches) {
          walk(branch);
        }
      }
    };
    walk(view);
    expect(foundToolCall).toBe(true);
  });
});
