import { useState, memo } from "react";
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
  activeStreams: Set<string>;
}

interface MessageGroup {
  runId: string;
  role: "user" | "assistant";
  nodes: ViewNode[];
}

function collectRunIds(nodes: ViewNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    ids.add(node.runId);
    for (const branch of node.branches) {
      for (const id of collectRunIds(branch)) ids.add(id);
    }
  }
  return ids;
}

function groupNodes(nodes: ViewNode[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const node of nodes) {
    const last = groups[groups.length - 1];
    if (last && last.runId === node.runId) {
      last.nodes.push(node);
    } else {
      groups.push({ runId: node.runId, role: node.role, nodes: [node] });
    }
  }
  return groups;
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

function CollapsiblePre({
  label,
  text,
  className,
}: {
  label: string;
  text: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ");

  return (
    <div className="mt-1">
      <div className="flex w-full items-start gap-1 text-left">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 text-gray-500 hover:text-gray-300"
        >
          {expanded ? "▼" : "▶"}
        </button>
        {expanded ? (
          <pre
            className={`whitespace-pre-wrap break-words select-text ${className ?? "text-gray-400"}`}
          >
            {text}
          </pre>
        ) : (
          <span
            className={`cursor-pointer truncate font-mono ${className ?? "text-gray-400"}`}
            onClick={() => {
              const sel = window.getSelection();
              if (sel && sel.toString().length > 0) return;
              setExpanded(true);
            }}
          >
            <span className="text-gray-500">{label}: </span>
            {oneLine}
          </span>
        )}
      </div>
    </div>
  );
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
      <CollapsiblePre label="params" text={inputStr} className="text-gray-400" />
      {outputStr && (
        <div className="mt-1 border-t border-gray-700 pt-1">
          <CollapsiblePre label="result" text={outputStr} className="text-gray-300" />
        </div>
      )}
    </div>
  );
}

const MessageGroupComponent = memo(function MessageGroupComponent({
  group,
  pendingRelays,
  permissionHandlers,
}: {
  group: MessageGroup;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  const isUser = group.role === "user";
  const isStreaming = group.nodes.some((n) => n.status === "streaming");
  const groupRelays = pendingRelays.filter((r) => r.runId === group.runId);

  return (
    <div className="mb-4">
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${group.runId.replace(/-/g, "").slice(-7)}`}
        {isStreaming && (
          <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
        )}
      </div>
      {group.nodes.map((node) => (
        <NodeContent
          key={node.id}
          node={node}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
      {groupRelays.map((relay) => (
        <PermissionPromptInline
          key={relay.relayId}
          request={relay}
          onAllow={() => permissionHandlers.onAllow(relay)}
          onAllowAll={() => permissionHandlers.onAllowAll(relay)}
          onDeny={() => permissionHandlers.onDeny(relay)}
        />
      ))}
    </div>
  );
});

function NodeContent({
  node,
  pendingRelays,
  permissionHandlers,
}: {
  node: ViewNode;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}) {
  return (
    <>
      <ContentView content={node.content} />
      {node.branches.map((branch, i) => (
        <BranchView
          key={i}
          branch={branch}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
    </>
  );
}

const emptyStreams: Set<string> = new Set();

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

  if (branch.length === 0) return null;

  return (
    <div className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mb-1 text-xs text-gray-400 hover:text-gray-200"
      >
        {expanded ? "▼ Collapse subthread" : "▶ Expand subthread"}
      </button>
      <div
        className={expanded ? "" : "flex max-h-[100px] flex-col-reverse overflow-hidden"}
        style={expanded ? undefined : { maskImage: "linear-gradient(transparent, black 40%)" }}
      >
        <div>
          <Thread
            nodes={branch}
            pendingRelays={pendingRelays}
            permissionHandlers={permissionHandlers}
            activeStreams={emptyStreams}
          />
        </div>
      </div>
    </div>
  );
}

function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
  activeStreams,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  activeStreams: Set<string>;
}) {
  const groups = groupNodes(nodes);
  const representedRunIds = collectRunIds(nodes);

  return (
    <>
      {groups.map((group) => (
        <MessageGroupComponent
          key={`${group.runId}-${group.nodes[0]!.id}`}
          group={group}
          pendingRelays={pendingRelays}
          permissionHandlers={permissionHandlers}
        />
      ))}
      {Array.from(activeStreams)
        .filter((runId) => !representedRunIds.has(runId))
        .map((runId) => (
          <div key={`streaming-${runId}`} className="mb-4">
            <div className="font-medium text-green-400">
              Agent-{runId.replace(/-/g, "").slice(-7)}
              <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-400" />
            </div>
          </div>
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
  const paramsStr = JSON.stringify(request.params, null, 2);

  return (
    <div className="my-4 rounded border border-yellow-600 bg-yellow-900/20 p-4">
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
  activeStreams,
}: ConversationThreadProps) {
  const viewNodes = projectThread(graph);

  if (viewNodes.length === 0 && activeStreams.size === 0) {
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
        activeStreams={activeStreams}
      />
    </div>
  );
}
