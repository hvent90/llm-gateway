import { useState, useCallback, useRef } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import { PermissionPrompt } from "./components/PermissionPrompt";
import {
  createSSETransport,
  createHTTPTransport,
  getRoots,
  getChildren,
  getContentBlocks,
  getRole,
} from "../../../packages/ai/client";
import { reduceConversation, createInitialConversation } from "../../../packages/ai/client";
import type { ConversationState, Message, Permissions } from "./types";

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

const sseTransport = createSSETransport({ baseUrl: "" });
const httpTransport = createHTTPTransport({ baseUrl: "" });

let userIdCounter = 0;
function nextUserId(): string {
  return `user-${++userIdCounter}`;
}

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialConversation);
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortControllerRef = useRef<AbortController | null>(null);

  // Build messages array from graph using selectors
  function buildMessagesFromGraph(graph: ConversationState["graph"]): Message[] {
    const messages: Message[] = [];
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

  // Core streaming function - can be called with different permissions
  const sendChat = useCallback(
    async (messages: Message[], permissions: Permissions, streamRunId: string) => {
      setState((s) => reduceConversation(s, { type: "stream_start", runId: streamRunId }));

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const stream = sseTransport.stream(
          { model: MODEL, messages, permissions },
          controller.signal,
        );

        for await (const event of stream) {
          setState((s) => reduceConversation(s, event));
        }
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") {
          console.error("Stream error:", error);
        }
      } finally {
        setState((s) => reduceConversation(s, { type: "stream_end", runId: streamRunId }));
        abortControllerRef.current = null;
      }
    },
    [],
  );

  const handleSubmit = useCallback(
    async (content: string) => {
      const userId = nextUserId();
      const streamRunId = `stream-${Date.now()}`;

      // Add user message to state
      setState((s) => reduceConversation(s, { type: "user", runId: userId, content }));

      // Read latest state via ref (setState is async, state would be stale)
      const current = stateRef.current;
      const messages = buildMessagesFromGraph(current.graph);
      messages.push({ role: "user", content });

      const permissions: Permissions = {
        allowlist: Array.from(current.grantedTools).map((tool) => ({ tool })),
      };

      await sendChat(messages, permissions, streamRunId);
    },
    [sendChat],
  );

  const pendingRelay = state.pendingRelays[0] ?? null;

  const handleAllow = useCallback(async () => {
    if (!pendingRelay || !state.sessionId) return;

    // Clear the relay without granting the tool permanently.
    // We use approved: false in the reducer (to skip granting) even though
    // we send approved: true to the server (to actually execute the tool).
    setState((s) =>
      reduceConversation(s, {
        type: "relay_resolved",
        relayId: pendingRelay.relayId,
        tool: pendingRelay.tool,
        approved: false,
      }),
    );

    await httpTransport.resolveRelay(state.sessionId, pendingRelay.relayId, {
      approved: true,
    });
  }, [state.sessionId, pendingRelay]);

  const handleAllowAll = useCallback(async () => {
    if (!pendingRelay || !state.sessionId) return;

    // Grant tool and clear relay
    setState((s) =>
      reduceConversation(s, {
        type: "relay_resolved",
        relayId: pendingRelay.relayId,
        tool: pendingRelay.tool,
        approved: true,
      }),
    );

    await httpTransport.resolveRelay(state.sessionId, pendingRelay.relayId, {
      approved: true,
    });
  }, [state.sessionId, pendingRelay]);

  const handleDeny = useCallback(async () => {
    if (!pendingRelay || !state.sessionId) return;

    // Clear relay with denial
    setState((s) =>
      reduceConversation(s, {
        type: "relay_resolved",
        relayId: pendingRelay.relayId,
        tool: pendingRelay.tool,
        approved: false,
      }),
    );

    await httpTransport.resolveRelay(state.sessionId, pendingRelay.relayId, {
      approved: false,
      reason: "User denied",
    });
  }, [state.sessionId, pendingRelay]);

  const isStreaming = state.activeStreams.size > 0;

  return (
    <div className="flex h-dvh flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main className="flex-1 overflow-auto p-3 sm:p-4">
        <ConversationThread graph={state.graph} />
        {pendingRelay && (
          <PermissionPrompt
            request={pendingRelay}
            onAllow={handleAllow}
            onAllowAll={handleAllowAll}
            onDeny={handleDeny}
          />
        )}
      </main>
      <InputArea onSubmit={handleSubmit} disabled={isStreaming || pendingRelay !== null} />
    </div>
  );
}
