import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import type { Message } from "../../types";
import type { ServerEvent } from "../server-event";
import type { ConversationState } from "../conversation";
import {
  createSSETransport,
  createHTTPTransport,
  createInitialConversation,
  reduceConversation,
  projectThread,
} from "../index";
import { collectAllViewNodes, startTestServer, echoTool, renderableKinds } from "./helpers";

/**
 * Stream a chat request and reduce all SSE events into conversation state.
 * Returns final state and collected server events.
 */
async function streamToState(
  baseUrl: string,
  messages: Message[],
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

    // Use projectThread to find the assistant ViewNode with "Hello world"
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const textNode = all.find(
      (n) => n.content.kind === "text" && n.content.text.includes("Hello world"),
    );
    expect(textNode).toBeDefined();
    expect(textNode!.role).toBe("assistant");
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

    // projectThread merges consecutive text nodes
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const merged = all.find(
      (n) => n.content.kind === "text" && n.content.text.includes("Hello world!"),
    );
    expect(merged).toBeDefined();
    expect(merged!.content.kind).toBe("text");
    if (merged!.content.kind === "text") {
      expect(merged!.content.text).toBe("Hello world!");
    }
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

    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);

    const reasoning = all.find((n) => n.content.kind === "reasoning");
    const text = all.find((n) => n.content.kind === "text");

    expect(reasoning).toBeDefined();
    expect(text).toBeDefined();
    if (reasoning!.content.kind === "reasoning") {
      expect(reasoning!.content.text).toContain("think");
    }
    if (text!.content.kind === "text") {
      expect(text!.content.text).toContain("answer");
    }
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

    // Use projectThread to find tool_call ViewNode with output attached
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const toolCallNode = all.find(
      (n) => n.content.kind === "tool_call" && n.content.name === "echo",
    );
    expect(toolCallNode).toBeDefined();
    if (toolCallNode!.content.kind === "tool_call") {
      expect(toolCallNode!.content.output).toBeDefined();
    }

    // Find the text ViewNode with "The echo said: ping"
    const textNode = all.find(
      (n) => n.content.kind === "text" && n.content.text.includes("The echo said: ping"),
    );
    expect(textNode).toBeDefined();
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

    // Use projectThread to find an error ViewNode
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const errorNode = all.find((n) => n.content.kind === "error");
    expect(errorNode).toBeDefined();
    if (errorNode!.content.kind === "error") {
      expect(errorNode!.content.message).toContain("Provider exploded");
    }
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
    state = reduceConversation(state, { type: "stream_start" });

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "Hello assistant" }],
    })) {
      state = reduceConversation(state, event);
    }

    state = reduceConversation(state, { type: "stream_end" });

    // Use projectThread to verify user and assistant ViewNodes
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);

    // Find user ViewNode
    const userNode = all.find(
      (n) =>
        n.role === "user" && n.content.kind === "user" && n.content.content === "Hello assistant",
    );
    expect(userNode).toBeDefined();

    // Find assistant ViewNode with text
    const assistantNode = all.find(
      (n) =>
        n.role === "assistant" &&
        n.content.kind === "text" &&
        n.content.text.includes("I am the assistant"),
    );
    expect(assistantNode).toBeDefined();

    // Stream should be inactive
    expect(state.isConnected).toBe(false);
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

    // All content-bearing graph nodes should appear in the projectThread output
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const projectedIds = new Set(all.map((n) => n.id));

    // Check every content-bearing node in the graph is represented
    for (const [, node] of state.graph.nodes) {
      if (renderableKinds.has(node.kind)) {
        expect(projectedIds.has(node.id)).toBe(true);
      }
    }
  });

  test("streamed text is visible through projection during streaming", async () => {
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
      const viewNodes = projectThread(state.graph);
      const all = collectAllViewNodes(viewNodes);
      const visible: string[] = [];
      for (const n of all) {
        if (n.content.kind === "text") visible.push(n.content.text);
      }
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
    let state = createInitialConversation();

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo test" }],
      permissions: { allowlist: [{ tool: "echo" }] },
    })) {
      state = reduceConversation(state, event);
    }

    // All content-bearing nodes must be reachable via projectThread
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const projectedIds = new Set(all.map((n) => n.id));

    for (const [, node] of state.graph.nodes) {
      if (renderableKinds.has(node.kind)) {
        expect(projectedIds.has(node.id)).toBe(true);
      }
    }

    // Should have "Echo result" text visible
    const allText = all
      .filter((n) => n.content.kind === "text")
      .map((n) => (n.content as { kind: "text"; text: string }).text)
      .join("");
    expect(allText).toContain("Echo result");
  });
});
