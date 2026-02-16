import { useState, useCallback, useRef, useEffect } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import type { PermissionHandlers } from "./components/ConversationThread";
import { GraphView } from "./components/GraphView";
import { createSSETransport, createHTTPTransport } from "../../../packages/ai/client";
import {
  reduceConversation,
  createInitialConversation,
  projectMessages,
} from "../../../packages/ai/client/hypergraph";
import type { ConversationState, Message, PendingRelay, Permissions, ServerEvent } from "./types";

const sseTransport = createSSETransport({ baseUrl: "" });
const httpTransport = createHTTPTransport({ baseUrl: "" });

let userIdCounter = 0;
function nextUserId(): string {
  return `user-${++userIdCounter}`;
}

export default function App() {
  const [state, setState] = useState<ConversationState>(createInitialConversation);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [mode, setMode] = useState<"agent" | "rlm">("agent");
  const [view, setView] = useState<"chat" | "graph">("chat");
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/models")
      .then((r) => r.json())
      .then((data: { models: string[]; defaultModel?: string }) => {
        setModels(data.models);
        if (data.defaultModel) {
          setSelectedModel(data.defaultModel);
        } else if (data.models.length > 0) {
          setSelectedModel(data.models[0]);
        }
      })
      .catch(() => {});
  }, []);

  const sendChat = useCallback(
    async (
      model: string,
      messages: Message[],
      permissions: Permissions,
      chatMode: "agent" | "rlm",
    ) => {
      setState((s) => reduceConversation(s, { type: "stream_start" }));
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const pendingEvents: ServerEvent[] = [];
      let rafId: number | undefined;

      const flushPending = () => {
        if (rafId !== undefined) cancelAnimationFrame(rafId);
        rafId = undefined;
        if (pendingEvents.length > 0) {
          const batch = pendingEvents.splice(0);
          setState((s) => {
            let current = s;
            for (const e of batch) current = reduceConversation(current, e);
            return current;
          });
        }
      };

      try {
        const stream = sseTransport.stream(
          { model, messages, permissions, mode: chatMode },
          controller.signal,
        );
        for await (const event of stream) {
          pendingEvents.push(event);
          if (rafId === undefined) {
            rafId = requestAnimationFrame(() => {
              rafId = undefined;
              const batch = pendingEvents.splice(0);
              setState((s) => {
                let current = s;
                for (const e of batch) current = reduceConversation(current, e);
                return current;
              });
            });
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") {
          console.error("Stream error:", error);
          setStreamError(error.message);
        }
      } finally {
        flushPending();
        setState((s) => reduceConversation(s, { type: "stream_end" }));
        abortControllerRef.current = null;
      }
    },
    [],
  );

  const handleSubmit = useCallback(
    async (content: string) => {
      setStreamError(null);
      const userId = nextUserId();
      setState((s) => reduceConversation(s, { type: "user", runId: userId, content }));
      const current = stateRef.current;
      const messages = [...projectMessages(current.graph), { role: "user" as const, content }];
      await sendChat(selectedModel, messages, {}, mode);
    },
    [sendChat, selectedModel, mode],
  );

  const handleAllow = useCallback(
    async (relay: PendingRelay) => {
      if (!state.sessionId) return;
      setState((s) =>
        reduceConversation(s, {
          type: "relay_resolved",
          relayId: relay.relayId,
          tool: relay.tool,
          approved: false,
        }),
      );
      await httpTransport.resolveRelay(state.sessionId, relay.relayId, { approved: true });
    },
    [state.sessionId],
  );

  const handleAllowAll = useCallback(
    async (relay: PendingRelay) => {
      if (!state.sessionId) return;
      const sameTypeRelays = state.pendingRelays.filter((r) => r.tool === relay.tool);
      setState((s) => {
        let current = s;
        for (const r of sameTypeRelays) {
          current = reduceConversation(current, {
            type: "relay_resolved",
            relayId: r.relayId,
            tool: r.tool,
            approved: r.relayId === relay.relayId,
          });
        }
        return current;
      });
      const sessionId = state.sessionId;
      await Promise.all(
        sameTypeRelays.map((r) =>
          httpTransport.resolveRelay(sessionId, r.relayId, { approved: true, always: true }),
        ),
      );
    },
    [state.sessionId, state.pendingRelays],
  );

  const handleDeny = useCallback(
    async (relay: PendingRelay) => {
      if (!state.sessionId) return;
      setState((s) =>
        reduceConversation(s, {
          type: "relay_resolved",
          relayId: relay.relayId,
          tool: relay.tool,
          approved: false,
        }),
      );
      await httpTransport.resolveRelay(state.sessionId, relay.relayId, {
        approved: false,
        reason: "User denied",
      });
    },
    [state.sessionId],
  );

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const permissionHandlers: PermissionHandlers = {
    onAllow: handleAllow,
    onAllowAll: handleAllowAll,
    onDeny: handleDeny,
  };

  const isStreaming = state.isConnected;

  return (
    <div className="flex h-dvh flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-bold tracking-tight">LLM Gateway</h1>
        <div className="flex gap-1 rounded bg-neutral-800 p-0.5 text-sm">
          <button
            className={`rounded px-2 py-0.5 ${view === "chat" ? "bg-neutral-600 text-white" : "text-neutral-400"}`}
            onClick={() => setView("chat")}
          >
            Chat
          </button>
          <button
            className={`rounded px-2 py-0.5 ${view === "graph" ? "bg-neutral-600 text-white" : "text-neutral-400"}`}
            onClick={() => setView("graph")}
          >
            Graph
          </button>
        </div>
      </header>
      <main
        className={
          view === "chat"
            ? "flex flex-1 flex-col-reverse overflow-y-auto p-3 sm:p-4"
            : "flex flex-1 overflow-hidden"
        }
      >
        {view === "chat" ? (
          <div>
            <ConversationThread
              graph={state.graph}
              pendingRelays={state.pendingRelays}
              permissionHandlers={permissionHandlers}
            />
            {streamError && (
              <div className="mt-4 border border-neutral-700 p-3 text-sm text-red-400">
                error: {streamError}
              </div>
            )}
          </div>
        ) : (
          <GraphView graph={state.graph} />
        )}
      </main>
      <InputArea
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        disabled={isStreaming || state.pendingRelays.length > 0 || !selectedModel}
        isStreaming={isStreaming}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        mode={mode}
        onModeChange={setMode}
      />
    </div>
  );
}
