import { useRef, useEffect, useState, memo } from "react";
import type { ViewNode, ViewContent, PendingRelay } from "../types";
import { PermissionPrompt } from "./PermissionPrompt";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface ConversationThreadProps {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function ConversationThread({
  nodes,
  pendingRelays,
  permissionHandlers,
  activeStreams,
  scrollContainerRef,
}: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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
  }, [nodes, pendingRelays]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Thread
        nodes={nodes}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
        activeStreams={activeStreams}
      />
      <div ref={bottomRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread — renders a list of ViewNode[]
// ---------------------------------------------------------------------------

interface ThreadProps {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
  depth?: number;
}

function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
  activeStreams,
  depth = 0,
}: ThreadProps) {
  return (
    <>
      {nodes.map((node) => (
        <NodeView
          key={node.id}
          node={node}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
          activeStreams={activeStreams}
          depth={depth}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// NodeView — renders a single ViewNode with its branches
// ---------------------------------------------------------------------------

// Tailwind needs static class names for purge - can't use dynamic `ml-${n}`
const indentClasses = [
  "",
  "ml-2 sm:ml-4",
  "ml-4 sm:ml-8",
  "ml-6 sm:ml-12",
  "ml-8 sm:ml-16",
] as const;

interface NodeViewProps {
  node: ViewNode;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
  depth: number;
}

const NodeView = memo(function NodeView({
  node,
  pendingRelays,
  permissionHandlers,
  activeStreams,
  depth,
}: NodeViewProps) {
  const isUser = node.role === "user";
  const indent = indentClasses[Math.min(depth, 4)] ?? "ml-16";
  const nodeRelays = pendingRelays.filter((r) => r.runId === node.runId);
  const isStreaming = activeStreams.has(node.runId);

  return (
    <div className={`${indent} mb-4`}>
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${node.runId.slice(0, 8)}`}
        {isStreaming && (
          <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
        )}
      </div>
      <Content content={node.content} activeStreams={activeStreams} />
      {node.status === "error" && (
        <div className="mt-1 text-sm text-red-400">[error] Node failed</div>
      )}
      {nodeRelays.map((relay) => (
        <PermissionPrompt
          key={relay.relayId}
          request={relay}
          onAllow={() => permissionHandlers.onAllow(relay)}
          onAllowAll={() => permissionHandlers.onAllowAll(relay)}
          onDeny={() => permissionHandlers.onDeny(relay)}
        />
      ))}
      {node.branches.map((branch, i) => (
        <div key={i} className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
          <Thread
            nodes={branch}
            pendingRelays={pendingRelays}
            permissionHandlers={permissionHandlers}
            activeStreams={activeStreams}
            depth={depth + 1}
          />
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Content — renders a single ViewContent based on its kind
// ---------------------------------------------------------------------------

interface ContentProps {
  content: ViewContent;
  activeStreams: Set<string>;
}

function Content({ content, activeStreams }: ContentProps) {
  switch (content.kind) {
    case "user":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "text":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "reasoning":
      return (
        <div className="mt-1 text-sm italic text-gray-500">
          {"\uD83D\uDCAD"} {content.text}
        </div>
      );
    case "tool_call":
      return <ToolCallContent content={content} activeStreams={activeStreams} />;
  }
}

// ---------------------------------------------------------------------------
// ToolCallContent — renders a tool_call ViewContent with expand/collapse
// ---------------------------------------------------------------------------

interface ToolCallContentProps {
  content: Extract<ViewContent, { kind: "tool_call" }>;
  activeStreams: Set<string>;
}

const ToolCallContent = memo(function ToolCallContent({ content }: ToolCallContentProps) {
  const [expanded, setExpanded] = useState(false);

  const inputStr =
    typeof content.input === "string" ? content.input : JSON.stringify(content.input, null, 2);

  const outputStr =
    content.output !== undefined
      ? typeof content.output === "string"
        ? content.output
        : JSON.stringify(content.output, null, 2)
      : null;

  return (
    <div className="my-2 rounded border border-gray-700 bg-gray-800 p-2 text-sm">
      <div className="flex items-center justify-between font-mono text-yellow-400">
        <span>
          {"\uD83D\uDD27"} {content.name}
        </span>
        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs text-gray-400 hover:text-gray-200"
          >
            Collapse
          </button>
        )}
      </div>
      {expanded ? (
        <>
          <pre className="mt-1 whitespace-pre-wrap break-words text-gray-400">{inputStr}</pre>
          {outputStr && (
            <div className="mt-2 border-t border-gray-700 pt-2">
              <span className="text-gray-500">{"\u21B3"} </span>
              <pre className="whitespace-pre-wrap break-words text-gray-300">{outputStr}</pre>
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 w-full rounded bg-gray-700 px-2 py-1 text-left text-xs text-gray-400 hover:bg-gray-600 hover:text-gray-200"
        >
          {outputStr ? "Show details" : "Pending..."}
        </button>
      )}
    </div>
  );
});
