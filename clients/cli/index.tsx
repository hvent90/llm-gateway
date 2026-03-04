/**
 * LLM Gateway CLI Client
 *
 * Interactive terminal-based client for the LLM Gateway server.
 * Uses @opentui/solid for rendering a rich terminal interface with
 * fine-grained reactivity for efficient updates during streaming.
 */

import { render, useRenderer, useKeyboard } from "@opentui/solid";
import { createTextAttributes } from "@opentui/core";
import { createSignal, createMemo, createEffect, on, For, Show, onMount } from "solid-js";
import { createSSETransport, createHTTPTransport } from "../../packages/ai/client";
import {
  createInitialConversation,
  reduceConversation,
  projectThread,
  projectMessages,
  projectRepl,
} from "../../packages/ai/client/hypergraph";
import type { ConversationState, PendingRelay } from "../../packages/ai/client/hypergraph";
import type { ViewNode, ViewContent } from "../../packages/ai/client/hypergraph";
import { ReplView } from "../../packages/ui/cli/repl";
import { TrajectoryRecorder } from "../../packages/ai/client/trajectory";

// Configuration from environment
const MODEL = process.env.DEFAULT_MODEL ?? "nvidia/nemotron-nano-9b-v2:free";
const SERVER_URL = process.env.LLM_GATEWAY_URL ?? "http://localhost:4000";
const RLM_MAX_ITERATIONS = parseInt(process.env.RLM_MAX_ITERATIONS ?? "100", 10);
const RLM_MAX_DEPTH = parseInt(process.env.RLM_MAX_DEPTH ?? "4", 10);

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

// Render a single ViewContent item
function ContentView(props: { content: ViewContent; isUser: boolean }) {
  switch (props.content.kind) {
    case "user":
      return (
        <text wrapMode="word">
          {"You: "}
          {typeof props.content.content === "string"
            ? props.content.content
            : props.content.content
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("\n")}
        </text>
      );
    case "text":
      return <text wrapMode="word">{props.content.text.trimEnd()}</text>;
    case "reasoning":
      return (
        <box paddingLeft={2} borderLeft borderColor="gray">
          <text
            wrapMode="word"
            fg="gray"
            attributes={createTextAttributes({ dim: true, italic: true })}
          >
            {props.content.text.trimEnd()}
          </text>
        </box>
      );
    case "tool_call": {
      const inputStr =
        typeof props.content.input === "string"
          ? props.content.input
          : JSON.stringify(props.content.input);
      const outputStr =
        props.content.output !== undefined ? formatOutput(props.content.output) : null;
      return (
        <box>
          <text wrapMode="word">{`[tool] ${props.content.name}: ${inputStr}`}</text>
          <Show when={outputStr !== null}>
            <text wrapMode="word">{`   -> ${outputStr}`}</text>
          </Show>
        </box>
      );
    }
    case "error":
      return (
        <text wrapMode="word" fg="red">
          {`[error] ${props.content.message}`}
        </text>
      );
    case "relay":
      return (
        <box marginTop={1}>
          <text wrapMode="word" fg="yellow">
            {`[!] Permission Required\n   Tool: ${props.content.tool}\n   Params: ${JSON.stringify(props.content.params, null, 2)}\n   Enter 'y' to allow, 'n' to deny`}
          </text>
        </box>
      );
    case "pending":
      return (
        <text wrapMode="word" fg="gray">
          {"..."}
        </text>
      );
  }
}

// Render a subagent branch (indented)
function BranchView(props: { nodes: ViewNode[]; pendingRelays: PendingRelay[] }) {
  return (
    <Show when={props.nodes.length > 0}>
      <box marginLeft={2} borderLeft borderColor="gray" paddingLeft={1} marginTop={1}>
        <text fg="green" attributes={createTextAttributes({ dim: true })}>
          {`agent-${props.nodes[0]!.runId.replace(/-/g, "").slice(-7)}`}
        </text>
        <ThreadView nodes={props.nodes} pendingRelays={props.pendingRelays} />
      </box>
    </Show>
  );
}

// Render the flat ViewNode[] thread
function ThreadView(props: { nodes: ViewNode[]; pendingRelays: PendingRelay[] }) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <box marginTop={node.role === "user" ? 1 : 0} marginBottom={node.role === "user" ? 1 : 0}>
          <ContentView content={node.content} isUser={node.role === "user"} />
          <For each={node.branches}>
            {(branch) => <BranchView nodes={branch} pendingRelays={props.pendingRelays} />}
          </For>
        </box>
      )}
    </For>
  );
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
  const [mode, setMode] = createSignal<"agent" | "rlm">("agent");
  const [lastUserMessage, setLastUserMessage] = createSignal<string | null>(null);
  const [focusZone, setFocusZone] = createSignal<"input" | "repl">("input");

  const recorder = new TrajectoryRecorder({
    model: MODEL,
    mode: "rlm",
    serverUrl: SERVER_URL,
  });

  useKeyboard((key) => {
    if (key.name === "tab") {
      setMode((m) => (m === "agent" ? "rlm" : "agent"));
    }
  });

  const isStreaming = () => conversation().isConnected;

  // Auto-switch focus: repl during streaming, input when done
  createEffect(
    on(isStreaming, (streaming) => {
      if (mode() === "rlm") {
        setFocusZone(streaming ? "repl" : "input");
      }
    }),
  );
  const pendingRelay = () => conversation().pendingRelays[0] ?? null;
  const viewNodes = () => projectThread(conversation().graph);
  const replData = createMemo(() => projectRepl(conversation().graph));

  // Resolve a pending relay request
  async function resolveRelay(approved: boolean, always?: boolean) {
    const relay = pendingRelay();
    const session = conversation().sessionId;
    if (!relay || !session) {
      setStatusText("[error] No pending relay or session");
      return;
    }

    try {
      await httpTransport.resolveRelay(
        session,
        relay.relayId,
        approved
          ? { approved: true, always: always ?? false }
          : { approved: false, reason: "User denied" },
      );

      recorder.recordRelayResolution({
        relayId: relay.relayId,
        approved,
        always: always ?? false,
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
      for await (const event of sseTransport.stream({
        model: MODEL,
        messages: userMessages,
        mode: mode(),
        ...(mode() === "rlm" && { maxIterations: RLM_MAX_ITERATIONS, maxDepth: RLM_MAX_DEPTH }),
      })) {
        recorder.record(event);
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
    recorder.recordUserMessage(userInput);
    setLastUserMessage(userInput);
    setConversation((s) =>
      reduceConversation(s, { type: "user", runId: nextUserId(), content: userInput }),
    );

    // Start streaming
    setStatusText("Streaming...");

    // Build messages array for API from the graph
    const apiMessages = projectMessages(conversation().graph);

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

  async function handleSaveTrajectory(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `trajectories/trajectory-${timestamp}.json`;
    await recorder.flush(path);
    return path;
  }

  const replPermissions = {
    onAllow: (relay: { relayId: string }) => {
      const r = conversation().pendingRelays.find((p) => p.relayId === relay.relayId);
      if (r) resolveRelay(true);
    },
    onDeny: (relay: { relayId: string }) => {
      const r = conversation().pendingRelays.find((p) => p.relayId === relay.relayId);
      if (r) resolveRelay(false);
    },
    onPermitAll: () => {
      resolveRelay(true, true);
    },
  };

  const replPendingRelays = () =>
    conversation().pendingRelays.map((r) => ({
      relayId: r.relayId,
      runId: r.runId,
      tool: r.tool,
      params: r.params as Record<string, unknown>,
    }));

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
        flexDirection="row"
        justifyContent="space-between"
      >
        <text>LLM Gateway CLI | Model: {MODEL}</text>
        <text fg={mode() === "rlm" ? "#22c55e" : "#888"}>
          [{mode() === "rlm" ? "RLM" : "Agent"}] Tab:toggle
        </text>
      </box>

      <Show
        when={mode() === "rlm"}
        fallback={
          <>
            {/* Messages */}
            <box flexGrow={1} border borderStyle="single" borderColor="#6b7280">
              <scrollbox width="100%" height="100%" scrollY stickyScroll stickyStart="bottom">
                <Show when={viewNodes().length === 0}>
                  <text wrapMode="word">
                    Welcome! Type a message and press Enter to start chatting.
                  </text>
                </Show>
                <ThreadView nodes={viewNodes()} pendingRelays={conversation().pendingRelays} />
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
          </>
        }
      >
        {/* RLM mode: input at top, then repl view fills the rest */}
        <box
          height={3}
          border
          borderStyle="rounded"
          borderColor={focusZone() === "input" ? "#22c55e" : "#444"}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          gap={1}
          onMouseDown={() => setFocusZone("input")}
        >
          <text width={2}>{">"}</text>
          <input
            flexGrow={1}
            value={inputValue()}
            onInput={setInputValue}
            onSubmit={handleSubmit}
            placeholder="Describe your task..."
            focused={focusZone() === "input"}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>
        <box flexGrow={1} onMouseDown={() => setFocusZone("repl")}>
          <ReplView
            data={replData}
            pendingRelays={replPendingRelays}
            permissions={replPermissions}
            focused={focusZone() === "repl"}
            userMessage={lastUserMessage}
            onSave={handleSaveTrajectory}
          />
        </box>
      </Show>
    </box>
  );
}

// Entry point
render(() => <ChatApp />);
