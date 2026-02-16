/**
 * Hypergraph Client Integration Tests
 *
 * Port of packages/ai/client/__tests__/client-integration.test.ts
 * using the hypergraph conversation reducer and projections.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import type { ServerEvent } from "../../server-event";
import { createInitialConversation, reduceConversation } from "../conversation";
import { projectThread } from "../projections/thread";
import { projectMessages } from "../projections/messages";
import { createSSETransport } from "../../transports/sse";
import { createHTTPTransport } from "../../transports/http";
import { collectAllViewNodes, startTestServer, echoTool } from "../../__tests__/helpers";

// --- Shared test state ---

let srv: Server<unknown> | undefined;

afterEach(() => {
  if (srv) {
    srv.stop(true);
    srv = undefined;
  }
});

// =====================================================================
// Web client scenarios
// =====================================================================

describe("Web Client Integration (Hypergraph)", () => {
  test("handleSubmit flow: user event -> stream_start -> SSE events -> stream_end -> graph", async () => {
    const setup = await startTestServer({
      responses: [{ events: [{ type: "text", content: "Web response" }] }],
    });
    srv = setup.server;

    // Simulate handleSubmit
    let state = createInitialConversation();
    const userId = "user-1";

    // 1. Add user message
    state = reduceConversation(state, { type: "user", runId: userId, content: "Hello from web" });

    // 2. Build messages from graph
    const messages = [
      ...projectMessages(state.graph),
      { role: "user" as const, content: "Hello from web" },
    ];

    // 3. Stream
    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);

    for await (const event of transport.stream({
      model: "deterministic",
      messages,
      permissions: { allowlist: [] },
    })) {
      state = reduceConversation(state, event);
    }

    state = reduceConversation(state, { type: "stream_end" });

    // 4. Verify graph structure via projectThread
    expect(state.sessionId).toBeDefined();
    expect(state.isConnected).toBe(false);

    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);

    // User node should be present
    const userNode = all.find(
      (n) =>
        n.role === "user" && n.content.kind === "user" && n.content.content === "Hello from web",
    );
    expect(userNode).toBeDefined();

    // Assistant node exists with response text
    const assistantNode = all.find(
      (n) =>
        n.role === "assistant" &&
        n.content.kind === "text" &&
        n.content.text.includes("Web response"),
    );
    expect(assistantNode).toBeDefined();
  });

  test("handleAllow (allow once): clears relay without granting tool", async () => {
    const setup = await startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "once" } }] },
          { events: [{ type: "text", content: "Tool ran once" }] },
        ],
      },
      [echoTool],
    );
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo once" }],
      permissions: { allowlist: [] },
    })) {
      state = reduceConversation(state, event);

      if (event.type === "relay") {
        // handleAllow: approved:false in reducer (no grant), approved:true to server
        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: "echo",
          approved: false, // allow once = don't grant permanently
        });

        await httpTransport.resolveRelay(state.sessionId!, event.id, {
          approved: true,
        });
      }
    }

    // Relay is cleared
    expect(state.pendingRelays.length).toBe(0);
  });

  test("handleAllowAll: clears relay AND grants tool permanently", async () => {
    const setup = await startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "all" } }] },
          { events: [{ type: "text", content: "Tool ran, granted forever" }] },
        ],
      },
      [echoTool],
    );
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo all" }],
      permissions: { allowlist: [] },
    })) {
      state = reduceConversation(state, event);

      if (event.type === "relay") {
        // handleAllowAll: approved:true in reducer (grant) + approved:true to server
        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: "echo",
          approved: true,
        });

        await httpTransport.resolveRelay(state.sessionId!, event.id, {
          approved: true,
        });
      }
    }

    expect(state.pendingRelays.length).toBe(0);
  });

  test("handleDeny: clears relay with denial, tool_result has denied status", async () => {
    const setup = await startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "no" } }] },
          { events: [{ type: "text", content: "Tool was denied" }] },
        ],
      },
      [echoTool],
    );
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();
    const events: ServerEvent[] = [];

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "deny echo" }],
      permissions: { allowlist: [] },
    })) {
      events.push(event);
      state = reduceConversation(state, event);

      if (event.type === "relay") {
        // handleDeny
        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: "echo",
          approved: false,
        });

        await httpTransport.resolveRelay(state.sessionId!, event.id, {
          approved: false,
          reason: "User denied",
        });
      }
    }

    expect(state.pendingRelays.length).toBe(0);

    // Should have a denied tool_result
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    const denied = toolResults.find(
      (e) =>
        (e as { output: unknown }).output &&
        (e as { output: { status?: string } }).output.status === "denied",
    );
    expect(denied).toBeDefined();
  });

  test("projectMessages extracts messages in tree order", () => {
    let state = createInitialConversation();

    // Build a simple user -> assistant graph manually
    state = reduceConversation(state, {
      type: "user",
      runId: "user-1",
      content: "What is 2+2?",
    });
    // Simulate assistant response
    state = reduceConversation(state, {
      type: "text",
      id: "t1",
      runId: "assistant-1",
      agentId: "a1",
      content: "The answer is 4",
    } as ServerEvent);

    const messages = projectMessages(state.graph);

    // User message should come first since it's a root with no children that are roots
    expect(messages.length).toBe(2);
    expect(messages[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "The answer is 4",
      tool_calls: undefined,
    });
  });
});

// =====================================================================
// CLI client scenarios
// =====================================================================

describe("CLI Client Integration (Hypergraph)", () => {
  test("projectMessages includes tool calls and results", () => {
    let state = createInitialConversation();

    // Build graph with user message and assistant with tool call + result
    state = reduceConversation(state, {
      type: "user",
      runId: "user-1",
      content: "Run ls",
    });

    // Simulate assistant events
    const assistantRunId = "assistant-1";
    state = reduceConversation(state, {
      type: "text",
      id: "t1",
      runId: assistantRunId,
      agentId: "a1",
      content: "Sure, running ls",
    } as ServerEvent);
    state = reduceConversation(state, {
      type: "tool_call",
      id: "tc-1",
      runId: assistantRunId,
      agentId: "a1",
      name: "bash",
      input: { command: "ls" },
    } as ServerEvent);
    state = reduceConversation(state, {
      type: "tool_result",
      id: "tc-1",
      runId: assistantRunId,
      agentId: "a1",
      name: "bash",
      output: "file.txt",
    } as ServerEvent);

    const apiMessages = projectMessages(state.graph);

    // User message
    expect(apiMessages[0]).toEqual({ role: "user", content: "Run ls" });

    // Assistant message with tool_calls
    expect(apiMessages[1]).toEqual({
      role: "assistant",
      content: "Sure, running ls",
      tool_calls: [{ id: "tc-1", name: "bash", arguments: { command: "ls" } }],
    });

    // Tool result message
    expect(apiMessages[2]).toEqual({
      role: "tool",
      tool_call_id: "tc-1",
      content: "file.txt",
    });
  });

  test("relay approval flow: y/yes resolves relay and updates state", async () => {
    const setup = await startTestServer(
      {
        responses: [
          { events: [{ type: "tool_call", name: "echo", input: { message: "cli" } }] },
          { events: [{ type: "text", content: "CLI approved" }] },
        ],
      },
      [echoTool],
    );
    srv = setup.server;

    // Simulate CLI flow: stream -> detect relay -> approve
    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    const events: ServerEvent[] = [];
    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo from cli" }],
      permissions: { allowlist: [] },
    })) {
      events.push(event);
      state = reduceConversation(state, event);

      if (event.type === "relay") {
        // CLI resolveRelay: HTTP first, then reducer
        await httpTransport.resolveRelay(state.sessionId!, event.id, {
          approved: true,
        });

        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: event.tool,
          approved: true,
        });
      }
    }

    expect(state.pendingRelays.length).toBe(0);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
  });

  test("error events present in graph nodes", async () => {
    const setup = await startTestServer({
      responses: [
        {
          events: [
            { type: "text", content: "Before error" },
            { type: "error", message: "Something went wrong" },
          ],
        },
      ],
    });
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "fail" }],
    })) {
      state = reduceConversation(state, event);
    }

    // Find error in graph — in hypergraph, errors are chunk nodes with content.type === "error"
    let foundError = false;
    for (const [, node] of state.graph.nodes) {
      if (
        node.kind === "chunk" &&
        (node.content as any).type === "error" &&
        (node.content as any).message?.includes("Something went wrong")
      ) {
        foundError = true;
      }
    }
    expect(foundError).toBe(true);

    // Also verify via projectThread
    const viewNodes = projectThread(state.graph);
    const all = collectAllViewNodes(viewNodes);
    const errorNode = all.find(
      (n) => n.content.kind === "error" && n.content.message.includes("Something went wrong"),
    );
    expect(errorNode).toBeDefined();
  });

  test("stream lifecycle: stream_start/stream_end toggle isConnected", async () => {
    const setup = await startTestServer({
      responses: [{ events: [{ type: "text", content: "streaming" }] }],
    });
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    // Before stream
    expect(state.isConnected).toBe(false);

    // stream_start sets isConnected
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);

    // Stream events from server
    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "go" }],
    })) {
      state = reduceConversation(state, event);
    }

    // stream_end clears isConnected
    state = reduceConversation(state, { type: "stream_end" });
    expect(state.isConnected).toBe(false);
  });
});
