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
import { createSSETransport, createHTTPTransport } from "../../packages/ai/client";
import type { ServerEvent } from "../../packages/ai/client/server-event";

// Configuration from environment
const MODEL = process.env.LLM_MODEL ?? "nvidia/nemotron-nano-9b-v2:free";
const SERVER_URL = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000";

const sseTransport = createSSETransport({ baseUrl: SERVER_URL });
const httpTransport = createHTTPTransport({ baseUrl: SERVER_URL });

// Message types
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  isReasoning?: boolean;
}

// Generate unique IDs
let idCounter = 0;
function generateId(): string {
  return `msg-${++idCounter}`;
}

// Message component - only re-renders when THIS message changes
function MessageView(props: { message: Message }) {
  // User messages get extra margin to separate conversation turns
  const isUser = () => props.message.role === "user";

  return (
    <box marginTop={isUser() ? 1 : 0} marginBottom={isUser() ? 1 : 0}>
      <Show
        when={props.message.isReasoning}
        fallback={
          <text wrapMode="word">
            {isUser() ? "You: " : ""}
            {props.message.content.trimEnd()}
          </text>
        }
      >
        <box paddingLeft={2} borderLeft borderColor="gray">
          <text
            wrapMode="word"
            fg="gray"
            attributes={createTextAttributes({ dim: true, italic: true })}
          >
            {props.message.content.trimEnd()}
          </text>
        </box>
      </Show>
    </box>
  );
}

// Main App Component
function ChatApp() {
  const renderer = useRenderer();

  // Start the render loop - required for SSH/remote terminals
  onMount(() => {
    renderer.start();
  });

  const [messages, setMessages] = createSignal<Message[]>([
    {
      id: generateId(),
      role: "system",
      content: "Welcome! Type a message and press Enter to start chatting.",
    },
  ]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [inputValue, setInputValue] = createSignal("");
  const [statusText, setStatusText] = createSignal(`Connected to ${SERVER_URL}`);
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [pendingRelay, setPendingRelay] = createSignal<{
    relayId: string;
    toolCallId: string;
    tool: string;
    params: Record<string, unknown>;
  } | null>(null);

  // Format tool output for display
  function formatOutput(output: unknown): string {
    const str = JSON.stringify(output, null, 2);
    const lines = str.split("\n");
    if (lines.length <= 6) return str;
    return lines.slice(0, 5).join("\n") + `\n... (${lines.length - 5} more lines)`;
  }

  // Add a message to the conversation, returns the ID
  function addMessage(role: Message["role"], content: string, isReasoning = false): string {
    const id = generateId();
    setMessages((prev) => [...prev, { id, role, content, isReasoning }]);
    return id;
  }

  // Append content to a message by ID
  function appendToMessage(id: string, content: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + content } : m)),
    );
  }

  // Handle a parsed server event
  function handleEvent(
    event: ServerEvent,
    state: { currentMsgId: string | null; isReasoning: boolean },
  ) {
    switch (event.type) {
      case "connected":
        setSessionId(event.sessionId);
        break;

      case "text":
        // If switching from reasoning to text, start a new message
        if (state.isReasoning) {
          state.currentMsgId = addMessage("assistant", event.content);
          state.isReasoning = false;
        } else if (state.currentMsgId) {
          appendToMessage(state.currentMsgId, event.content);
        } else {
          state.currentMsgId = addMessage("assistant", event.content);
        }
        break;

      case "reasoning":
        // If switching from text to reasoning, start a new message
        if (!state.isReasoning && state.currentMsgId) {
          state.currentMsgId = addMessage("assistant", event.content, true);
          state.isReasoning = true;
        } else if (state.currentMsgId && state.isReasoning) {
          appendToMessage(state.currentMsgId, event.content);
        } else {
          state.currentMsgId = addMessage("assistant", event.content, true);
          state.isReasoning = true;
        }
        break;

      case "tool_call": {
        state.currentMsgId = null;
        state.isReasoning = false;
        const inputStr =
          typeof event.input === "string" ? event.input : JSON.stringify(event.input);
        addMessage("assistant", `[tool] ${event.name}: ${inputStr}`);
        break;
      }

      case "tool_result": {
        const outputStr = formatOutput(event.output);
        addMessage("assistant", `   -> ${outputStr}`);
        break;
      }

      case "relay":
        state.currentMsgId = null;
        state.isReasoning = false;
        setPendingRelay({
          relayId: event.id,
          toolCallId: event.toolCallId,
          tool: event.tool,
          params: event.params,
        });
        showRelayPrompt(event.tool, event.params);
        break;

      case "error":
        state.currentMsgId = null;
        state.isReasoning = false;
        addMessage("assistant", `[error] ${event.message}`);
        break;
    }
  }

  // Show permission prompt
  function showRelayPrompt(tool: string, params: Record<string, unknown>) {
    const paramsStr = JSON.stringify(params, null, 2);
    addMessage(
      "system",
      `[!] Permission Required\n   Tool: ${tool}\n   Params: ${paramsStr}\n   Enter 'y' to allow, 'n' to deny`,
    );
    setStatusText("[!] Permission required - awaiting response");
  }

  // Resolve a pending relay request
  async function resolveRelay(approved: boolean) {
    const relay = pendingRelay();
    const session = sessionId();
    if (!relay || !session) {
      addMessage("system", "[error] No pending relay or session");
      return;
    }

    try {
      await httpTransport.resolveRelay(session, relay.relayId, {
        approved,
        reason: approved ? undefined : "User denied",
      });

      addMessage("system", approved ? "[ok] Allowed" : "[x] Denied");
      setPendingRelay(null);
      setStatusText("Streaming...");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      addMessage("system", `[error] Failed to resolve relay: ${errorMsg}`);
    }
  }

  // Stream chat from the server using SSE transport
  async function streamChat(userMessages: Array<{ role: string; content: string }>) {
    const state = { currentMsgId: null as string | null, isReasoning: false };

    for await (const event of sseTransport.stream({ model: MODEL, messages: userMessages })) {
      handleEvent(event, state);
    }
  }

  // Handle user submission
  async function handleSubmit(value: string) {
    const userInput = value.trim();
    if (!userInput) return;

    // Clear input
    setInputValue("");

    // Handle permission response if pending
    const permission = pendingRelay();
    if (permission) {
      const normalized = userInput.toLowerCase();
      const isApprove = ["y", "yes", "allow", "a"].includes(normalized);
      const isDeny = ["n", "no", "deny", "d"].includes(normalized);

      if (isApprove || isDeny) {
        await resolveRelay(isApprove);
        return;
      }
      // Invalid response, prompt again
      addMessage("system", "[!] Please enter 'y' to allow or 'n' to deny.");
      return;
    }

    if (isStreaming()) return;

    // Add user message to display
    addMessage("user", userInput);

    // Start streaming
    setIsStreaming(true);
    setStatusText("Streaming...");

    // Build messages array for API (excluding system messages and reasoning)
    const apiMessages = messages()
      .filter((m) => m.role !== "system" && !m.isReasoning)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      await streamChat(apiMessages);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      addMessage("system", `[error] ${errorMsg}`);
    } finally {
      setIsStreaming(false);
      setStatusText(`Connected to ${SERVER_URL}`);
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
          <For each={messages()}>{(msg) => <MessageView message={msg} />}</For>
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
