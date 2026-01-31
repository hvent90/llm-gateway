/**
 * LLM Gateway CLI Client
 *
 * Interactive terminal-based client for the LLM Gateway server.
 * Uses @opentui/solid for rendering a rich terminal interface with
 * fine-grained reactivity for efficient updates during streaming.
 */

import { render, useRenderer } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { createSignal, For, Show, onMount } from "solid-js";
import {
  createSSETransport,
  createHTTPTransport,
  createInitialConversation,
  reduceConversation,
  getRoots,
  getChildren,
  getContentBlocks,
  getRole,
} from "../../packages/ai/client";
import type { ConversationState, ContentBlock, PendingRelay } from "../../packages/ai/client";

// Configuration from environment
const MODEL = process.env.DEFAULT_MODEL ?? "nvidia/nemotron-nano-9b-v2:free";
const SERVER_URL = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000";

const sseTransport = createSSETransport({ baseUrl: SERVER_URL });
const httpTransport = createHTTPTransport({ baseUrl: SERVER_URL });

// Generate unique user message IDs
let userIdCounter = 0;
function nextUserId(): string {
  return `user-${++userIdCounter}`;
}

// Format tool output for display
function formatOutput(output: unknown): string {
  const str = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  const lines = str.split("\n");
  if (lines.length <= 6) return str;
  return lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`;
}

// Block renderer for a single ContentBlock
function BlockView(props: { block: ContentBlock; isUser: boolean }) {
  return (
    <Show
      when={props.block.type === "reasoning"}
      fallback={
        <Show
          when={props.block.type === "tool_call"}
          fallback={
            <text wrapMode="word">
              {props.isUser ? "You: " : ""}
              {(props.block as Extract<ContentBlock, { type: "text" }>).content.trimEnd()}
            </text>
          }
        >
          {(() => {
            const tc = props.block as Extract<ContentBlock, { type: "tool_call" }>;
            const inputStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input);
            const outputStr = tc.output !== undefined ? formatOutput(tc.output) : null;
            return (
              <box>
                <text wrapMode="word">{`[tool] ${tc.name}: ${inputStr}`}</text>
                <Show when={outputStr !== null}>
                  <text wrapMode="word">{`   -> ${outputStr}`}</text>
                </Show>
              </box>
            );
          })()}
        </Show>
      }
    >
      <box paddingLeft={2} borderLeft borderColor="gray">
        <text
          wrapMode="word"
          fg="gray"
          attributes={createTextAttributes({ dim: true, italic: true })}
        >
          {(props.block as Extract<ContentBlock, { type: "reasoning" }>).content.trimEnd()}
        </text>
      </box>
    </Show>
  );
}

// Extract error messages from a graph node's events
function getErrorMessages(graph: ConversationState["graph"], runId: string): string[] {
  const node = graph.nodes.get(runId);
  if (!node) return [];
  return node.events.filter((e) => e.type === "error").map((e) => e.message);
}

// Recursive node renderer — walks the conversation graph
function NodeView(props: {
  graph: ConversationState["graph"];
  runId: string;
  pendingRelays: PendingRelay[];
}) {
  const role = () => getRole(props.graph, props.runId);
  const blocks = () => getContentBlocks(props.graph, props.runId);
  const children = () => getChildren(props.graph, props.runId);
  const errors = () => getErrorMessages(props.graph, props.runId);
  const nodeRelays = () => props.pendingRelays.filter((r) => r.runId === props.runId);

  return (
    <box marginTop={role() === "user" ? 1 : 0} marginBottom={role() === "user" ? 1 : 0}>
      <For each={blocks()}>{(block) => <BlockView block={block} isUser={role() === "user"} />}</For>
      <For each={errors()}>
        {(msg) => (
          <text wrapMode="word" fg="red">
            {`[error] ${msg}`}
          </text>
        )}
      </For>
      <For each={nodeRelays()}>
        {(relay) => {
          const paramsStr = JSON.stringify(relay.params, null, 2);
          return (
            <box marginTop={1}>
              <text wrapMode="word" fg="yellow">
                {`[!] Permission Required\n   Tool: ${relay.tool}\n   Params: ${paramsStr}\n   Enter 'y' to allow, 'n' to deny`}
              </text>
            </box>
          );
        }}
      </For>
      <For each={children()}>
        {(childId) => (
          <NodeView graph={props.graph} runId={childId} pendingRelays={props.pendingRelays} />
        )}
      </For>
    </box>
  );
}

// Build API messages from the conversation graph
function buildApiMessages(
  graph: ConversationState["graph"],
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const traverse = (runIds: string[]) => {
    for (const runId of runIds) {
      const role = getRole(graph, runId);
      const blocks = getContentBlocks(graph, runId);

      // Build content from all block types (text + tool calls)
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

// Main App Component
function ChatApp() {
  const renderer = useRenderer();

  // Use auto mode - renders on-demand when state changes, not continuously
  onMount(() => {
    renderer.auto();
  });

  const [conversation, setConversation] = createSignal<ConversationState>(
    createInitialConversation(),
  );
  const [inputValue, setInputValue] = createSignal("");
  const [statusText, setStatusText] = createSignal(`Connected to ${SERVER_URL}`);

  const isStreaming = () => conversation().isConnected;
  const pendingRelay = () => conversation().pendingRelays[0] ?? null;
  const roots = () => getRoots(conversation().graph);

  // Resolve a pending relay request
  async function resolveRelay(approved: boolean) {
    const relay = pendingRelay();
    const session = conversation().sessionId;
    if (!relay || !session) {
      setStatusText("[error] No pending relay or session");
      return;
    }

    try {
      await httpTransport.resolveRelay(session, relay.relayId, {
        approved,
        reason: approved ? undefined : "User denied",
      });

      setConversation((s) =>
        reduceConversation(s, {
          type: "relay_resolved",
          relayId: relay.relayId,
          tool: relay.tool,
          approved,
        }),
      );
      setStatusText(approved ? "Allowed - streaming..." : "Denied - streaming...");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setStatusText(`[error] Failed to resolve relay: ${errorMsg}`);
    }
  }

  // Stream chat from the server using SSE transport
  async function streamChat(userMessages: Array<{ role: string; content: string }>) {
    setConversation((s) => reduceConversation(s, { type: "stream_start" }));

    try {
      for await (const event of sseTransport.stream({ model: MODEL, messages: userMessages })) {
        setConversation((s) => reduceConversation(s, event));
      }
    } finally {
      setConversation((s) => reduceConversation(s, { type: "stream_end" }));
    }
  }

  // Handle user submission
  async function handleSubmit(value: string) {
    const userInput = value.trim();
    if (!userInput) return;

    // Clear input
    setInputValue("");

    // Handle permission response if pending
    const relay = pendingRelay();
    if (relay) {
      const normalized = userInput.toLowerCase();
      const isApprove = ["y", "yes", "allow", "a"].includes(normalized);
      const isDeny = ["n", "no", "deny", "d"].includes(normalized);

      if (isApprove || isDeny) {
        await resolveRelay(isApprove);
        return;
      }
      // Invalid response, prompt again
      setStatusText("[!] Please enter 'y' to allow or 'n' to deny.");
      return;
    }

    if (isStreaming()) return;

    // Add user message to conversation graph
    setConversation((s) =>
      reduceConversation(s, { type: "user", runId: nextUserId(), content: userInput }),
    );

    // Start streaming
    setStatusText("Streaming...");

    // Build messages array for API from the graph
    const apiMessages = buildApiMessages(conversation().graph);

    try {
      await streamChat(apiMessages);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setStatusText(`[error] ${errorMsg}`);
    } finally {
      if (!pendingRelay()) {
        setStatusText(`Connected to ${SERVER_URL}`);
      }
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <box
        height={3}
        border
        borderStyle="rounded"
        borderColor="#3b82f6"
        paddingLeft={1}
        paddingRight={1}
      >
        <text>LLM Gateway CLI | Model: {MODEL}</text>
      </box>

      {/* Messages */}
      <box flexGrow={1} border borderStyle="single" borderColor="#6b7280">
        <scrollbox width="100%" height="100%" scrollY stickyScroll stickyStart="bottom">
          <Show when={roots().length === 0}>
            <text wrapMode="word">Welcome! Type a message and press Enter to start chatting.</text>
          </Show>
          <For each={roots()}>
            {(runId) => (
              <NodeView
                graph={conversation().graph}
                runId={runId}
                pendingRelays={conversation().pendingRelays}
              />
            )}
          </For>
        </scrollbox>
      </box>

      {/* Input */}
      <box
        height={3}
        border
        borderStyle="rounded"
        borderColor="#22c55e"
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        gap={1}
      >
        <text width={2}>{">"}</text>
        <input
          flexGrow={1}
          value={inputValue()}
          onInput={setInputValue}
          onSubmit={handleSubmit}
          placeholder="Type your message..."
          focused
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
        />
      </box>

      {/* Status bar */}
      <text height={1}>{statusText()}</text>
    </box>
  );
}

// Entry point
render(() => <ChatApp />);
