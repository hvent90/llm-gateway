import { useState, useCallback, useRef } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { streamChat, resolvePermission } from "./services/chat";
import {
  createInitialState,
  addUserMessage,
  handleEvent,
  addErrorMessage,
} from "./state/conversation";
import type { ConversationState, Message, Permissions } from "./types";

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

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
    setState((s) => ({ ...s, isStreaming: true, pendingPermission: null }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const stream = streamChat({ model: MODEL, messages, permissions }, controller.signal);

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
    if (!state.pendingPermission || !state.sessionId) return;

    // Clear pending permission immediately
    setState((s) => ({ ...s, pendingPermission: null }));

    // Resolve permission - stream continues automatically
    await resolvePermission(state.sessionId, state.pendingPermission.toolCallId, true);
  }, [state.sessionId, state.pendingPermission]);

  const handleAllowAll = useCallback(async () => {
    if (!state.pendingPermission || !state.sessionId) return;

    const tool = state.pendingPermission.tool;
    const toolCallId = state.pendingPermission.toolCallId;

    // Add to granted tools and clear pending permission
    setState((s) => ({
      ...s,
      grantedTools: new Set([...s.grantedTools, tool]),
      pendingPermission: null,
    }));

    // Resolve permission - stream continues automatically
    await resolvePermission(state.sessionId, toolCallId, true);
  }, [state.sessionId, state.pendingPermission]);

  const handleDeny = useCallback(async () => {
    if (!state.pendingPermission || !state.sessionId) return;

    // Clear pending permission immediately
    setState((s) => ({ ...s, pendingPermission: null }));

    // Resolve permission with denial - stream continues automatically
    await resolvePermission(
      state.sessionId,
      state.pendingPermission.toolCallId,
      false,
      "User denied",
    );
  }, [state.sessionId, state.pendingPermission]);

  return (
    <div className="flex h-dvh flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-3 sm:p-4">
        <ConversationThread messages={state.messages} />
        {state.pendingPermission && (
          <PermissionPrompt
            request={state.pendingPermission}
            onAllow={handleAllow}
            onAllowAll={handleAllowAll}
            onDeny={handleDeny}
          />
        )}
      </main>
      <InputArea
        onSubmit={handleSubmit}
        disabled={state.isStreaming || state.pendingPermission !== null}
      />
    </div>
  );
}
