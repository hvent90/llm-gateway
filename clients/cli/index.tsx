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
  projectThread,
} from "../../packages/ai/client";
import type {
  ConversationState,
  PendingRelay,
  ViewNode,
  ViewContent,
} from "../../packages/ai/client";

// Configuration from environment
const MODEL = process.env.LLM_MODEL ?? "nvidia/nemotron-nano-9b-v2:free";
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

// Block renderer for a single ViewContent
function BlockView(props: { content: ViewContent; isUser: boolean }) {
  return (
    <Show
      when={props.content.kind === "reasoning"}
      fallback={
        <Show
          when={props.content.kind === "tool_call"}
          fallback={
            <text wrapMode="word">
              {props.isUser ? "You: " : ""}
              {(
                props.content as
                  | Extract<ViewContent, { kind: "text" }>
                  | Extract<ViewContent, { kind: "user" }>
              ).text.trimEnd()}
            </text>
          }
        >
          {(() => {
            const tc = props.content as Extract<ViewContent, { kind: "tool_call" }>;
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
          {(props.content as Extract<ViewContent, { kind: "reasoning" }>).text.trimEnd()}
        </text>
      </box>
    </Show>
  );
}

// Recursive node renderer — walks the ViewNode tree
function NodeView(props: { node: ViewNode; pendingRelays: PendingRelay[] }) {
  const nodeRelays = () => props.pendingRelays.filter((r) => r.runId === props.node.runId);

  return (
    <box
      marginTop={props.node.role === "user" ? 1 : 0}
      marginBottom={props.node.role === "user" ? 1 : 0}
    >
      <BlockView content={props.node.content} isUser={props.node.role === "user"} />
      <Show when={props.node.status === "error"}>
        <text wrapMode="word" fg="red">
          {"[error] Node failed"}
        </text>
      </Show>
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
      <For each={props.node.branches}>
        {(branch) => (
          <For each={branch}>
            {(child) => <NodeView node={child} pendingRelays={props.pendingRelays} />}
          </For>
        )}
      </For>
    </box>
  );
}

// Build API messages from ViewNode[]
function buildApiMessages(nodes: ViewNode[]): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const walk = (list: ViewNode[]) => {
    for (const node of list) {
      const c = node.content;
      const parts: string[] = [];

      if (c.kind === "text" || c.kind === "user") {
        parts.push(c.text);
      } else if (c.kind === "tool_call") {
        const inputStr = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
        parts.push(`[tool] ${c.name}: ${inputStr}`);
        if (c.output !== undefined) {
          parts.push(`   -> ${formatOutput(c.output)}`);
        }
      }
      // Skip reasoning — not sent to API

      const content = parts.join("\n");
      if (content) {
        messages.push({ role: node.role, content });
      }

      for (const branch of node.branches) {
        walk(branch);
      }
    }
  };
  walk(nodes);
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

  const isStreaming = () => conversation().activeStreams.size > 0;
  const pendingRelay = () => conversation().pendingRelays[0] ?? null;
  const viewNodes = () => projectThread(conversation().graph);

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

    // Build messages array for API from the view
    const apiMessages = buildApiMessages(viewNodes());

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
          <Show when={viewNodes().length === 0}>
            <text wrapMode="word">Welcome! Type a message and press Enter to start chatting.</text>
          </Show>
          <For each={viewNodes()}>
            {(node) => <NodeView node={node} pendingRelays={conversation().pendingRelays} />}
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
