import { useRef, useEffect } from "react";
import { getRoots } from "../../../../packages/ai/client";
import type { GraphState, PendingRelay } from "../types";
import { MessageNode } from "./MessageNode";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface ConversationThreadProps {
  graph: GraphState;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function ConversationThread({
  graph,
  pendingRelays,
  permissionHandlers,
  activeStreams,
  scrollContainerRef,
}: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const roots = getRoots(graph);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef]);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [graph, pendingRelays]);

  if (roots.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {roots.map((runId) => (
        <MessageNode
          key={runId}
          graph={graph}
          runId={runId}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
          activeStreams={activeStreams}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
