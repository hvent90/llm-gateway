/**
 * Client Integration Tests
 *
 * Exercises the exact code paths the web and CLI clients use --
 * without React/Solid rendering. Both clients follow:
 * add user event to state -> build messages from graph -> stream via SSE -> reduce events -> projectThread.
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
  createHTTPTransport,
  createInitialConversation,
  reduceConversation,
  projectThread,
} from "../index";
import type { ViewNode } from "../index";

// --- Helpers ---

function collectAllViewNodes(nodes: ViewNode[]): ViewNode[] {
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

// --- Helpers ---

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

// --- Web client helper functions (using projectThread instead of old selectors) ---

function buildMessagesFromGraph(
  graph: ConversationState["graph"],
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const viewNodes = projectThread(graph);
  const all = collectAllViewNodes(viewNodes);

  for (const n of all) {
    if (n.content.kind === "text") {
      messages.push({ role: n.role, content: n.content.text });
    } else if (n.content.kind === "user") {
      messages.push({ role: n.role, content: n.content.text });
    }
  }
  return messages;
}

// --- CLI client helper functions (using projectThread instead of old selectors) ---

function formatOutput(output: unknown): string {
  const str = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  const lines = str.split("\n");
  if (lines.length <= 6) return str;
  return lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`;
}

function buildApiMessages(
  graph: ConversationState["graph"],
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const viewNodes = projectThread(graph);
  const all = collectAllViewNodes(viewNodes);

  // Group consecutive ViewNodes by runId to build per-run messages
  let currentRunId: string | null = null;
  let currentRole: string | null = null;
  let parts: string[] = [];

  function flush() {
    if (parts.length > 0 && currentRole) {
      messages.push({ role: currentRole, content: parts.join("\n") });
    }
    parts = [];
  }

  for (const n of all) {
    if (n.runId !== currentRunId) {
      flush();
      currentRunId = n.runId;
      currentRole = n.role;
    }

    if (n.content.kind === "text") {
      parts.push(n.content.text);
    } else if (n.content.kind === "user") {
      parts.push(n.content.text);
    } else if (n.content.kind === "tool_call") {
      const inputStr =
        typeof n.content.input === "string" ? n.content.input : JSON.stringify(n.content.input);
      parts.push(`[tool] ${n.content.name}: ${inputStr}`);
      if (n.content.output !== undefined) {
        parts.push(`   -> ${formatOutput(n.content.output)}`);
      }
    }
    // Skip reasoning blocks -- not sent to API
  }
  flush();

  return messages;
}

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

describe("Web Client Integration", () => {
  test("handleSubmit flow: user event -> stream_start -> SSE events -> stream_end -> graph", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "Web response" }] }],
    });
    srv = setup.server;

    // Simulate handleSubmit
    let state = createInitialConversation();
    const userId = "user-1";

    // 1. Add user message
    state = reduceConversation(state, { type: "user", runId: userId, content: "Hello from web" });

    // 2. Build messages from graph
    const messages = buildMessagesFromGraph(state.graph);
    messages.push({ role: "user", content: "Hello from web" });

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
      (n) => n.role === "user" && n.content.kind === "user" && n.content.text === "Hello from web",
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
    const setup = startTestServer(
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
    // Tool is NOT granted permanently
    expect(state.grantedTools.has("echo")).toBe(false);
  });

  test("handleAllowAll: clears relay AND grants tool permanently", async () => {
    const setup = startTestServer(
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
    expect(state.grantedTools.has("echo")).toBe(true);
  });

  test("handleDeny: clears relay with denial, tool_result has denied status", async () => {
    const setup = startTestServer(
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
    expect(state.grantedTools.has("echo")).toBe(false);

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

  test("grantedTools included in next turn's permissions allowlist", async () => {
    // Simulate two turns: first grants the tool, second uses it automatically
    const setup = startTestServer(
      {
        responses: [
          // Turn 1: tool call (needs relay, gets granted)
          { events: [{ type: "tool_call", name: "echo", input: { message: "first" } }] },
          { events: [{ type: "text", content: "First turn done" }] },
          // Turn 2: tool call (should auto-approve since granted)
          { events: [{ type: "tool_call", name: "echo", input: { message: "second" } }] },
          { events: [{ type: "text", content: "Second turn done" }] },
        ],
      },
      [echoTool],
    );
    srv = setup.server;

    const httpTransport = createHTTPTransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    // --- Turn 1: grant via relay ---
    const t1Transport = createSSETransport({ baseUrl: setup.baseUrl });
    state = reduceConversation(state, { type: "user", runId: "u1", content: "echo first" });
    state = reduceConversation(state, { type: "stream_start" });

    for await (const event of t1Transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo first" }],
      permissions: { allowlist: [] },
    })) {
      state = reduceConversation(state, event);

      if (event.type === "relay") {
        state = reduceConversation(state, {
          type: "relay_resolved",
          relayId: event.id,
          tool: "echo",
          approved: true, // Grant permanently
        });
        await httpTransport.resolveRelay(state.sessionId!, event.id, { approved: true });
      }
    }
    state = reduceConversation(state, { type: "stream_end" });

    expect(state.grantedTools.has("echo")).toBe(true);

    // --- Turn 2: build permissions from grantedTools ---
    const permissions = {
      allowlist: Array.from(state.grantedTools).map((tool) => ({ tool })),
    };
    expect(permissions.allowlist).toEqual([{ tool: "echo" }]);

    // Stream second turn -- tool should auto-execute (no relay)
    const t2Transport = createSSETransport({ baseUrl: setup.baseUrl });
    state = reduceConversation(state, { type: "user", runId: "u2", content: "echo second" });
    state = reduceConversation(state, { type: "stream_start" });

    const t2Events: ServerEvent[] = [];
    for await (const event of t2Transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo second" }],
      permissions,
    })) {
      t2Events.push(event);
      state = reduceConversation(state, event);
    }
    state = reduceConversation(state, { type: "stream_end" });

    // No relay in turn 2 -- tool auto-approved
    expect(t2Events.some((e) => e.type === "relay")).toBe(false);
    expect(t2Events.some((e) => e.type === "tool_call")).toBe(true);
    expect(t2Events.some((e) => e.type === "tool_result")).toBe(true);
  });

  test("buildMessagesFromGraph extracts messages in tree order", () => {
    let state = createInitialConversation();

    // Build a simple user -> assistant graph manually
    state = reduceConversation(state, {
      type: "user",
      runId: "user-1",
      content: "What is 2+2?",
    });
    // Simulate assistant response as root (no parentId -- would be a root)
    state = reduceConversation(state, {
      type: "text",
      id: "t1",
      runId: "assistant-1",
      agentId: "a1",
      content: "The answer is 4",
    } as ServerEvent);

    const messages = buildMessagesFromGraph(state.graph);

    // User message should come first since it's a root with no children that are roots
    expect(messages.length).toBe(2);
    expect(messages[0]).toEqual({ role: "user", content: "What is 2+2?" });
    expect(messages[1]).toEqual({ role: "assistant", content: "The answer is 4" });
  });
});

// =====================================================================
// CLI client scenarios
// =====================================================================

describe("CLI Client Integration", () => {
  test("buildApiMessages includes tool history as [tool] format", () => {
    let state = createInitialConversation();

    // Build graph with user message and assistant with tool call + result
    state = reduceConversation(state, {
      type: "user",
      runId: "user-1",
      content: "Run ls",
    });

    // Simulate assistant events on a root node (for simplicity in extraction)
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

    const apiMessages = buildApiMessages(state.graph);

    // User message
    expect(apiMessages[0]).toEqual({ role: "user", content: "Run ls" });

    // Assistant message should include tool call in [tool] format
    const assistantMsg = apiMessages[1]!;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toContain("[tool] bash:");
    expect(assistantMsg.content).toContain("file.txt");
    expect(assistantMsg.content).toContain("Sure, running ls");
  });

  test("relay approval flow: y/yes resolves relay and updates state", async () => {
    const setup = startTestServer(
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
    // CLI always passes approved to reducer, so tool is granted
    expect(state.grantedTools.has("echo")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
  });

  test("error events present in graph nodes", async () => {
    const setup = startTestServer({
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

    // Find error node directly in graph
    let foundError = false;
    for (const [, node] of state.graph.nodes) {
      if (node.kind === "error" && node.message.includes("Something went wrong")) {
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

  test("stream lifecycle: stream_start/stream_end toggle isConnected, harness events toggle activeStreams", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "streaming" }] }],
    });
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();

    // Before stream
    expect(state.isConnected).toBe(false);
    expect(state.activeStreams.size).toBe(0);

    // stream_start sets isConnected (not activeStreams)
    state = reduceConversation(state, { type: "stream_start" });
    expect(state.isConnected).toBe(true);
    expect(state.activeStreams.size).toBe(0);

    // Stream events -- harness_start/harness_end from server populate activeStreams
    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "go" }],
    })) {
      state = reduceConversation(state, event);
    }

    // After all events, harness_end should have cleared activeStreams
    expect(state.activeStreams.size).toBe(0);

    // stream_end clears isConnected
    state = reduceConversation(state, { type: "stream_end" });
    expect(state.isConnected).toBe(false);
  });
});
