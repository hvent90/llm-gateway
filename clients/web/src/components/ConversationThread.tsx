import { useRef, useEffect } from "react";
import { getRoots } from "../../../../packages/ai/client";
import type { GraphState } from "../types";
import { MessageNode } from "./MessageNode";

interface ConversationThreadProps {
  graph: GraphState;
}

export function ConversationThread({ graph }: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const roots = getRoots(graph);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [graph]);

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
        <MessageNode key={runId} graph={graph} runId={runId} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
