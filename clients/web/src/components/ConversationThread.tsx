import { useState, useRef, useEffect, memo } from "react";
import { projectThread } from "../../../../packages/ai/client";
import type { ViewNode, ViewContent, Graph, PendingRelay } from "../types";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface ConversationThreadProps {
  graph: Graph;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

function ContentView({ content }: { content: ViewContent }) {
  switch (content.kind) {
    case "user":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "text":
      return <div className="mt-1 whitespace-pre-wrap text-gray-200">{content.text}</div>;
    case "reasoning":
      return <div className="mt-1 text-sm italic text-gray-500">{content.text}</div>;
    case "error":
      return (
        <div className="mt-1 rounded border border-red-700 bg-red-900/20 p-2 text-sm text-red-400">
          {content.message}
        </div>
      );
    case "relay":
      return null;
    case "tool_call":
      return <ToolCallView content={content} />;
  }
}

function ToolCallView({ content }: { content: Extract<ViewContent, { kind: "tool_call" }> }) {
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
      <div className="font-mono text-yellow-400">{content.name}</div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-gray-400">{inputStr}</pre>
      {outputStr && (
        <div className="mt-2 border-t border-gray-700 pt-2">
          <pre className="whitespace-pre-wrap break-words text-gray-300">{outputStr}</pre>
        </div>
      )}
    </div>
  );
}

const ViewNodeComponent = memo(function ViewNodeComponent({
  node,
  pendingRelays,
  permissionHandlers,
}: {
  node: ViewNode;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  const isUser = node.role === "user";
  const isStreaming = node.status === "streaming";
  const nodeRelays = pendingRelays.filter((r) => r.runId === node.runId);

  return (
    <div className="mb-4">
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${node.runId.slice(0, 8)}`}
        {isStreaming && (
          <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
        )}
      </div>
      <ContentView content={node.content} />
      {nodeRelays.map((relay) => (
        <PermissionPromptInline
          key={relay.relayId}
          request={relay}
          onAllow={() => permissionHandlers.onAllow(relay)}
          onAllowAll={() => permissionHandlers.onAllowAll(relay)}
          onDeny={() => permissionHandlers.onDeny(relay)}
        />
      ))}
      {node.branches.map((branch, i) => (
        <BranchView
          key={i}
          branch={branch}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
    </div>
  );
});

function BranchView({
  branch,
  pendingRelays,
  permissionHandlers,
}: {
  branch: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  const isStreaming = branch.some((n) => n.status === "streaming");

  if (branch.length === 0) return null;

  if (!expanded && !isStreaming) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1 w-full rounded bg-gray-700 px-2 py-1 text-left text-xs text-gray-400 hover:bg-gray-600 hover:text-gray-200"
      >
        {branch.length} node{branch.length !== 1 ? "s" : ""} in subthread
      </button>
    );
  }

  return (
    <div className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
      {!isStreaming && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mb-1 text-xs text-gray-400 hover:text-gray-200"
        >
          Collapse
        </button>
      )}
      <Thread
        nodes={branch}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
      />
    </div>
  );
}

function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  return (
    <>
      {nodes.map((node) => (
        <ViewNodeComponent
          key={node.id}
          node={node}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
    </>
  );
}

function PermissionPromptInline({
  request,
  onAllow,
  onAllowAll,
  onDeny,
}: {
  request: PendingRelay;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const paramsStr = JSON.stringify(request.params, null, 2);

  return (
    <div ref={ref} className="my-4 rounded border border-yellow-600 bg-yellow-900/20 p-4">
      <div className="mb-2 font-medium text-yellow-400">Permission Required</div>
      <div className="mb-2 text-sm text-gray-300">
        Tool: <span className="font-mono text-yellow-300">{request.tool}</span>
      </div>
      <pre className="mb-4 overflow-x-auto rounded bg-gray-800 p-2 text-sm text-gray-400">
        {paramsStr}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={onAllow}
          className="rounded bg-green-600 px-3 py-1 text-sm font-medium text-white hover:bg-green-700"
        >
          Allow
        </button>
        <button
          onClick={onAllowAll}
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
        >
          Always Allow
        </button>
        <button
          onClick={onDeny}
          className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export function ConversationThread({
  graph,
  pendingRelays,
  permissionHandlers,
  scrollContainerRef,
}: ConversationThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const viewNodes = projectThread(graph);

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

  if (viewNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-gray-500">
        Start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Thread
        nodes={viewNodes}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
      />
      <div ref={bottomRef} />
    </div>
  );
}
