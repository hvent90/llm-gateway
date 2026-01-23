import { useRef, useEffect } from "react";
import type { MessageNode as MessageNodeType } from "../types";
import { MessageNode } from "./MessageNode";

interface ConversationThreadProps {
  messages: MessageNodeType[];
}

export function ConversationThread({ messages }: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((node) => (
        <MessageNode key={node.id} node={node} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
