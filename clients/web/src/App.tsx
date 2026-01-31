import { useState, useCallback, useRef, useEffect } from "react";
import { InputArea } from "./components/InputArea";
import { ConversationThread } from "./components/ConversationThread";
import type { PermissionHandlers } from "./components/ConversationThread";
import {
  createSSETransport,
  createHTTPTransport,
  projectThread,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "../../../packages/ai/client";
import { reduceConversation, createInitialConversation } from "../../../packages/ai/client";
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
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const resolvingRelaysRef = useRef(new Set<string>());

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

  function buildMessagesFromGraph(graph: ConversationState["graph"]): Message[] {
    const messages: Message[] = [];
    const viewNodes = projectThread(graph);
    const collect = (nodes: typeof viewNodes) => {
      for (const node of nodes) {
        if (node.content.kind === "text" || node.content.kind === "user") {
          messages.push({ role: node.role, content: node.content.text });
        }
        for (const branch of node.branches) {
          collect(branch);
        }
      }
    };
    collect(viewNodes);
    return messages;
  }

  const sendChat = useCallback(
    async (model: string, messages: Message[], permissions: Permissions) => {
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
        const stream = sseTransport.stream({ model, messages, permissions }, controller.signal);
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
      const messages = buildMessagesFromGraph(current.graph);
      messages.push({ role: "user", content });
      const permissions: Permissions = {
        allowlist: Array.from(current.grantedTools).map((tool) => ({ tool })),
      };
      await sendChat(selectedModel, messages, permissions);
    },
    [sendChat, selectedModel],
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
      const sameTypeRelays = getSameToolRelays(state, relay.tool);
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
          httpTransport.resolveRelay(sessionId, r.relayId, { approved: true }),
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

  useEffect(() => {
    if (!state.sessionId) return;
    const autoApprovable = getAutoApprovableRelays(state).filter(
      (r) => !resolvingRelaysRef.current.has(r.relayId),
    );
    if (autoApprovable.length === 0) return;

    const sessionId = state.sessionId;
    for (const r of autoApprovable) {
      resolvingRelaysRef.current.add(r.relayId);
      httpTransport
        .resolveRelay(sessionId, r.relayId, { approved: true })
        .then(() => {
          resolvingRelaysRef.current.delete(r.relayId);
          setState((s) =>
            reduceConversation(s, {
              type: "relay_resolved",
              relayId: r.relayId,
              tool: r.tool,
              approved: false,
            }),
          );
        })
        .catch(() => {
          resolvingRelaysRef.current.delete(r.relayId);
        });
    }
  }, [state.pendingRelays, state.grantedTools, state.sessionId]);

  const isStreaming = state.isConnected;

  return (
    <div className="flex h-dvh flex-col bg-gray-900 text-gray-100">
      <header className="border-b border-gray-700 px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:py-3 sm:pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">LLM Gateway</h1>
      </header>
      <main ref={scrollContainerRef} className="flex-1 overflow-auto p-3 sm:p-4">
        <ConversationThread
          graph={state.graph}
          pendingRelays={state.pendingRelays}
          permissionHandlers={permissionHandlers}
          scrollContainerRef={scrollContainerRef}
          activeStreams={state.activeStreams}
        />
        {streamError && (
          <div className="mt-4 rounded border border-red-600 bg-red-900/20 p-3 text-sm text-red-400">
            Connection error: {streamError}
          </div>
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
      />
    </div>
  );
}
