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
  getRoots,
  getChildren,
  getContentBlocks,
  getRole,
  getText,
  getToolCalls,
} from "../index";

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
): { server: Server; baseUrl: string } {
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

  state = reduceConversation(state, { type: "stream_start", runId: "stream-1" });

  for await (const event of transport.stream({
    model: "deterministic",
    messages,
    ...(permissions && { permissions }),
  })) {
    events.push(event);
    state = reduceConversation(state, event);
  }

  state = reduceConversation(state, { type: "stream_end", runId: "stream-1" });
  return { state, events };
}

// --- Tests ---

let server: Server | undefined;

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

    // Find the assistant node with our text content
    let foundText = false;
    for (const [, node] of state.graph.nodes) {
      const text = getText(state.graph, node.runId);
      if (text.includes("Hello world")) {
        foundText = true;
        expect(getRole(state.graph, node.runId)).toBe("assistant");
      }
    }
    expect(foundText).toBe(true);
  });

  test("streaming text chunks merge into single text block", async () => {
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

    // Find the assistant node and check content blocks merge
    let found = false;
    for (const [, node] of state.graph.nodes) {
      const blocks = getContentBlocks(state.graph, node.runId);
      const textBlocks = blocks.filter((b) => b.type === "text");
      const fullText = textBlocks.map((b) => b.content).join("");
      if (fullText.includes("Hello world!")) {
        // getContentBlocks merges consecutive text events
        expect(textBlocks.length).toBe(1);
        expect(textBlocks[0].content).toBe("Hello world!");
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  test("reasoning + text: both block types present", async () => {
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

    // Find the node with both reasoning and text
    let found = false;
    for (const [, node] of state.graph.nodes) {
      const blocks = getContentBlocks(state.graph, node.runId);
      const reasoning = blocks.filter((b) => b.type === "reasoning");
      const text = blocks.filter((b) => b.type === "text");
      if (reasoning.length > 0 && text.length > 0) {
        expect(reasoning[0].content).toContain("think");
        expect(text[0].content).toContain("answer");
        found = true;
      }
    }
    expect(found).toBe(true);
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

    // Content blocks on the agent node should include tool_call with output
    let foundToolBlock = false;
    for (const [, node] of state.graph.nodes) {
      const blocks = getContentBlocks(state.graph, node.runId);
      for (const b of blocks) {
        if (b.type === "tool_call" && b.name === "echo") {
          expect(b.output).toBeDefined();
          foundToolBlock = true;
        }
      }
    }
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
        expect(state.pendingRelays[0].tool).toBe("echo");

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
          // After denial, agent still continues — model gets denied result and responds
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

  test("error from provider: error event in graph node", async () => {
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
    for (const [, node] of state.graph.nodes) {
      const hasError = node.events.some((e) => e.type === "error");
      if (hasError) foundError = true;
    }
    expect(foundError).toBe(true);
  });

  test("full round trip: user → stream → assistant with correct graph structure", async () => {
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
    state = reduceConversation(state, { type: "stream_start", runId: "s1" });

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "Hello assistant" }],
    })) {
      state = reduceConversation(state, event);
    }

    state = reduceConversation(state, { type: "stream_end", runId: "s1" });

    // Graph should have user root node
    const roots = getRoots(state.graph);
    expect(roots).toContain(userRunId);
    expect(getRole(state.graph, userRunId)).toBe("user");
    expect(getContentBlocks(state.graph, userRunId)).toEqual([
      { type: "text", content: "Hello assistant" },
    ]);

    // There should be an assistant node (may or may not be child of user,
    // depending on parentId — the server assigns parentId based on agent hierarchy)
    let foundAssistant = false;
    for (const [runId, node] of state.graph.nodes) {
      if (node.role === "assistant") {
        const text = getText(state.graph, runId);
        if (text.includes("I am the assistant")) {
          foundAssistant = true;
        }
      }
    }
    expect(foundAssistant).toBe(true);

    // Stream should be inactive
    expect(state.activeStreams.size).toBe(0);
  });

  test("assistant nodes are reachable via tree traversal (not orphaned)", async () => {
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

    // Collect all nodes reachable via tree traversal (the same way UIs render)
    const reachable = new Set<string>();
    const traverse = (runIds: string[]) => {
      for (const runId of runIds) {
        reachable.add(runId);
        traverse(getChildren(state.graph, runId));
      }
    };
    traverse(getRoots(state.graph));

    // Every node in the graph must be reachable via tree traversal
    for (const [runId] of state.graph.nodes) {
      expect(reachable.has(runId)).toBe(true);
    }
  });

  test("streamed text is visible through selectors during streaming", async () => {
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
    state = reduceConversation(state, { type: "stream_start", runId: "s1" });

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const snapshots: string[] = [];

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "Go" }],
    })) {
      state = reduceConversation(state, event);

      // After each event, check what text is visible via tree traversal
      const visible: string[] = [];
      const collect = (runIds: string[]) => {
        for (const runId of runIds) {
          const blocks = getContentBlocks(state.graph, runId);
          for (const b of blocks) {
            if (b.type === "text") visible.push(b.content);
          }
          collect(getChildren(state.graph, runId));
        }
      };
      collect(getRoots(state.graph));
      snapshots.push(visible.join(""));
    }

    // Filter to only snapshots with assistant content (skip "connected" event snapshot)
    const withContent = snapshots.filter((s) => s.includes("chunk"));
    expect(withContent.length).toBeGreaterThan(0);
    // The final snapshot should contain all chunks
    expect(withContent[withContent.length - 1]).toContain("chunk1chunk2");
  });

  test("tool call flow: all events reachable via tree traversal", async () => {
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
    const httpT = createHTTPTransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo test" }],
      permissions: { allowlist: [{ tool: "echo" }] },
    })) {
      state = reduceConversation(state, event);
    }

    // All nodes must be reachable
    const reachable = new Set<string>();
    const traverse = (runIds: string[]) => {
      for (const runId of runIds) {
        reachable.add(runId);
        traverse(getChildren(state.graph, runId));
      }
    };
    traverse(getRoots(state.graph));

    for (const [runId] of state.graph.nodes) {
      expect(reachable.has(runId)).toBe(true);
    }

    // Should have both tool_call and text content visible
    const allText: string[] = [];
    for (const runId of reachable) {
      allText.push(getText(state.graph, runId));
    }
    expect(allText.join("")).toContain("Echo result");
  });
});
