import { useState, useCallback, useRef } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { createSSETransport, createHTTPTransport } from "../../../packages/ai/client";
import {
  createInitialState,
  addUserMessage,
  handleEvent,
  addErrorMessage,
} from "./state/conversation";
import type { ConversationState, Message, Permissions } from "./types";

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

const sseTransport = createSSETransport({ baseUrl: "" });
const httpTransport = createHTTPTransport({ baseUrl: "" });

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialState);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Build messages array from current state
  const buildMessagesFromState = useCallback(
    (currentMessages: typeof state.messages): Message[] => {
      const messages: Message[] = [];
      const traverse = (nodes: typeof state.messages) => {
        for (const node of nodes) {
          // Extract text content from contentBlocks
          const textContent = node.contentBlocks
            .filter((block) => block.type === "text")
            .map((block) => block.content)
            .join("");
          if (textContent) {
            messages.push({ role: node.role, content: textContent });
          }
          traverse(node.children);
        }
      };
      traverse(currentMessages);
      return messages;
    },
    [],
  );

  // Core streaming function - can be called with different permissions
  const sendChat = useCallback(async (messages: Message[], permissions: Permissions) => {
    setState((s) => ({ ...s, isStreaming: true, pendingRelay: null }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const stream = sseTransport.stream(
        { model: MODEL, messages, permissions },
        controller.signal,
      );

      for await (const event of stream) {
        console.log("Received event:", event.type, event);
        setState((s) => handleEvent(s, event));
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Stream error:", error);
        setState((s) => addErrorMessage(s, error.message));
      }
    } finally {
      setState((s) => ({ ...s, isStreaming: false }));
      abortControllerRef.current = null;
    }
  }, []);

  const handleSubmit = useCallback(
    async (content: string) => {
      // Add user message to state
      setState((s) => addUserMessage(s, content));

      // Build messages including the new user message
      const messages = buildMessagesFromState(state.messages);
      messages.push({ role: "user", content });

      // Build permissions from granted tools
      const permissions: Permissions = {
        allowlist: Array.from(state.grantedTools).map((tool) => ({ tool })),
      };

      await sendChat(messages, permissions);
    },
    [state.messages, state.grantedTools, buildMessagesFromState, sendChat],
  );

  const handleAllow = useCallback(async () => {
    if (!state.pendingRelay || !state.sessionId) return;

    const relayId = state.pendingRelay.relayId;

    // Clear pending relay immediately
    setState((s) => ({ ...s, pendingRelay: null }));

    // Resolve relay - stream continues automatically
    await httpTransport.resolveRelay(state.sessionId, relayId, { approved: true });
  }, [state.sessionId, state.pendingRelay]);

  const handleAllowAll = useCallback(async () => {
    if (!state.pendingRelay || !state.sessionId) return;

    const tool = state.pendingRelay.tool;
    const relayId = state.pendingRelay.relayId;

    // Add to granted tools and clear pending relay
    setState((s) => ({
      ...s,
      grantedTools: new Set([...s.grantedTools, tool]),
      pendingRelay: null,
    }));

    // Resolve relay - stream continues automatically
    await httpTransport.resolveRelay(state.sessionId, relayId, { approved: true });
  }, [state.sessionId, state.pendingRelay]);

  const handleDeny = useCallback(async () => {
    if (!state.pendingRelay || !state.sessionId) return;

    const relayId = state.pendingRelay.relayId;

    // Clear pending relay immediately
    setState((s) => ({ ...s, pendingRelay: null }));

    // Resolve relay with denial - stream continues automatically
    await httpTransport.resolveRelay(state.sessionId, relayId, {
      approved: false,
      reason: "User denied",
    });
  }, [state.sessionId, state.pendingRelay]);

  return (
    <div className="flex h-dvh flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-3 sm:p-4">
        <ConversationThread messages={state.messages} />
        {state.pendingRelay && (
          <PermissionPrompt
            request={state.pendingRelay}
            onAllow={handleAllow}
            onAllowAll={handleAllowAll}
            onDeny={handleDeny}
          />
        )}
      </main>
      <InputArea
        onSubmit={handleSubmit}
        disabled={state.isStreaming || state.pendingRelay !== null}
      />
    </div>
  );
}
