import { useState, useCallback } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { streamChat } from "./services/chat";
import {
  createInitialState,
  addUserMessage,
  handleEvent,
} from "./state/conversation";
import type { ConversationState, Message } from "./types";

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialState);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const handleSubmit = useCallback(async (content: string) => {
    // Add user message
    setState((s) => ({ ...addUserMessage(s, content), isStreaming: true }));

    // Build messages array for API
    const messages: Message[] = [];
    const buildMessages = (nodes: typeof state.messages) => {
      for (const node of nodes) {
        messages.push({ role: node.role, content: node.content });
        buildMessages(node.children);
      }
    };
    buildMessages(state.messages);
    messages.push({ role: "user", content });

    // Create abort controller
    const controller = new AbortController();
    setAbortController(controller);

    try {
      const stream = streamChat(
        {
          model: MODEL,
          messages,
          permissions: Array.from(state.grantedTools),
        },
        controller.signal
      );

      for await (const event of stream) {
        setState((s) => handleEvent(s, event));
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Stream error:", error);
      }
    } finally {
      setState((s) => ({ ...s, isStreaming: false }));
      setAbortController(null);
    }
  }, [state.messages, state.grantedTools]);

  const handleAllow = useCallback(() => {
    // TODO: Send allow response to server
    setState((s) => ({ ...s, pendingPermission: null }));
  }, []);

  const handleAllowAll = useCallback(() => {
    if (state.pendingPermission) {
      const tool = state.pendingPermission.tool;
      setState((s) => ({
        ...s,
        pendingPermission: null,
        grantedTools: new Set([...s.grantedTools, tool]),
      }));
    }
  }, [state.pendingPermission]);

  const handleDeny = useCallback(() => {
    // TODO: Send deny response to server
    setState((s) => ({ ...s, pendingPermission: null }));
    abortController?.abort();
  }, [abortController]);

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-3">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-4">
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
