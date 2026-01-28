/**
 * Client Integration Tests
 *
 * Exercises the exact code paths the web and CLI clients use —
 * without React/Solid rendering. Both clients follow:
 * add user event to state → build messages from graph → stream via SSE → reduce events → use selectors.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod";
import type { Server } from "bun";
import type { ToolDefinition } from "../../types";
import type { ServerEvent } from "../server-event";
import type { ConversationState, ConversationEvent } from "../conversation";
import type { ContentBlock } from "../selectors";
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

// --- Helpers ---

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

// --- Web client helper functions (extracted from App.tsx patterns) ---

function buildMessagesFromGraph(
  graph: ConversationState["graph"],
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const traverse = (runIds: string[]) => {
    for (const runId of runIds) {
      const role = getRole(graph, runId);
      const blocks = getContentBlocks(graph, runId);
      const textContent = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.content)
        .join("");
      if (textContent && role) {
        messages.push({ role, content: textContent });
      }
      traverse(getChildren(graph, runId));
    }
  };
  traverse(getRoots(graph));
  return messages;
}

// --- CLI client helper functions (extracted from CLI index.tsx patterns) ---

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
  const traverse = (runIds: string[]) => {
    for (const runId of runIds) {
      const role = getRole(graph, runId);
      const blocks = getContentBlocks(graph, runId);
      const parts: string[] = [];
      for (const b of blocks) {
        if (b.type === "text") {
          parts.push(b.content);
        } else if (b.type === "tool_call") {
          const inputStr = typeof b.input === "string" ? b.input : JSON.stringify(b.input);
          parts.push(`[tool] ${b.name}: ${inputStr}`);
          if (b.output !== undefined) {
            parts.push(`   -> ${formatOutput(b.output)}`);
          }
        }
        // Skip reasoning blocks — not sent to API
      }
      const content = parts.join("\n");
      if (content && role) {
        messages.push({ role, content });
      }
      traverse(getChildren(graph, runId));
    }
  };
  traverse(getRoots(graph));
  return messages;
}

function getErrorMessages(graph: ConversationState["graph"], runId: string): string[] {
  const node = graph.nodes.get(runId);
  if (!node) return [];
  return node.events
    .filter((e) => e.type === "error")
    .map((e) => (e as Extract<ServerEvent, { type: "error" }>).message);
}

// --- Shared test state ---

let srv: Server | undefined;

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
  test("handleSubmit flow: user event → stream_start → SSE events → stream_end → graph", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "Web response" }] }],
    });
    srv = setup.server;

    // Simulate handleSubmit
    let state = createInitialConversation();
    const userId = "user-1";
    const streamRunId = "stream-1";

    // 1. Add user message
    state = reduceConversation(state, { type: "user", runId: userId, content: "Hello from web" });

    // 2. Build messages from graph
    const messages = buildMessagesFromGraph(state.graph);
    messages.push({ role: "user", content: "Hello from web" });

    // 3. Stream
    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    state = reduceConversation(state, { type: "stream_start", runId: streamRunId });
    expect(state.activeStreams.has(streamRunId)).toBe(true);

    for await (const event of transport.stream({
      model: "deterministic",
      messages,
      permissions: { allowlist: [] },
    })) {
      state = reduceConversation(state, event);
    }

    state = reduceConversation(state, { type: "stream_end", runId: streamRunId });

    // 4. Verify graph structure
    expect(state.sessionId).toBeDefined();
    expect(state.activeStreams.size).toBe(0);

    // User node is a root
    const roots = getRoots(state.graph);
    expect(roots).toContain(userId);
    expect(getRole(state.graph, userId)).toBe("user");

    // Assistant node exists with response text
    let foundAssistant = false;
    for (const [, node] of state.graph.nodes) {
      if (node.role === "assistant") {
        const text = getText(state.graph, node.runId);
        if (text.includes("Web response")) foundAssistant = true;
      }
    }
    expect(foundAssistant).toBe(true);
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
    state = reduceConversation(state, { type: "stream_start", runId: "s1" });

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
    state = reduceConversation(state, { type: "stream_end", runId: "s1" });

    expect(state.grantedTools.has("echo")).toBe(true);

    // --- Turn 2: build permissions from grantedTools ---
    const permissions = {
      allowlist: Array.from(state.grantedTools).map((tool) => ({ tool })),
    };
    expect(permissions.allowlist).toEqual([{ tool: "echo" }]);

    // Stream second turn — tool should auto-execute (no relay)
    const t2Transport = createSSETransport({ baseUrl: setup.baseUrl });
    state = reduceConversation(state, { type: "user", runId: "u2", content: "echo second" });
    state = reduceConversation(state, { type: "stream_start", runId: "s2" });

    const t2Events: ServerEvent[] = [];
    for await (const event of t2Transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "echo second" }],
      permissions,
    })) {
      t2Events.push(event);
      state = reduceConversation(state, event);
    }
    state = reduceConversation(state, { type: "stream_end", runId: "s2" });

    // No relay in turn 2 — tool auto-approved
    expect(t2Events.some((e) => e.type === "relay")).toBe(false);
    expect(t2Events.some((e) => e.type === "tool_call")).toBe(true);
    expect(t2Events.some((e) => e.type === "tool_result")).toBe(true);
  });

  test("buildMessagesFromGraph extracts messages in tree order", () => {
    let state = createInitialConversation();

    // Build a simple user → assistant graph manually
    state = reduceConversation(state, {
      type: "user",
      runId: "user-1",
      content: "What is 2+2?",
    });
    // Simulate assistant response as root (no parentId — would be a root)
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
    const assistantMsg = apiMessages[1];
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

    // Simulate CLI flow: stream → detect relay → approve
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

  test("error events extracted by getErrorMessages", async () => {
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

    // Find the node with the error
    let foundErrors: string[] = [];
    for (const [runId] of state.graph.nodes) {
      const errors = getErrorMessages(state.graph, runId);
      if (errors.length > 0) foundErrors = errors;
    }

    expect(foundErrors.length).toBeGreaterThan(0);
    expect(foundErrors[0]).toContain("Something went wrong");
  });

  test("stream lifecycle: stream_start/stream_end toggle activeStreams", async () => {
    const setup = startTestServer({
      responses: [{ events: [{ type: "text", content: "streaming" }] }],
    });
    srv = setup.server;

    const transport = createSSETransport({ baseUrl: setup.baseUrl });
    let state = createInitialConversation();
    const streamRunId = "cli-stream-1";

    // Before stream
    expect(state.activeStreams.size).toBe(0);

    // stream_start
    state = reduceConversation(state, { type: "stream_start", runId: streamRunId });
    expect(state.activeStreams.has(streamRunId)).toBe(true);
    expect(state.activeStreams.size).toBe(1);

    // Stream events
    for await (const event of transport.stream({
      model: "deterministic",
      messages: [{ role: "user", content: "go" }],
    })) {
      state = reduceConversation(state, event);
      // During streaming, activeStreams still has our stream
      expect(state.activeStreams.has(streamRunId)).toBe(true);
    }

    // stream_end
    state = reduceConversation(state, { type: "stream_end", runId: streamRunId });
    expect(state.activeStreams.has(streamRunId)).toBe(false);
    expect(state.activeStreams.size).toBe(0);
  });
});
