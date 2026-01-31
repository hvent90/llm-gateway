import { useState, memo } from "react";
import { Streamdown } from "streamdown";
import { projectThread, getActiveRunIds } from "../../../../packages/ai/client";
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
  isConnected: boolean;
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
      return <div className="mt-1 whitespace-pre-wrap">{content.text}</div>;
    case "text":
      return (
        <div className="mt-1 streamdown">
          <Streamdown>{content.text}</Streamdown>
        </div>
      );
    case "reasoning":
      return (
        <div className="mt-1 text-sm italic text-neutral-500 streamdown">
          <Streamdown>{content.text}</Streamdown>
        </div>
      );
    case "error":
      return (
        <div className="mt-1 border border-neutral-700 p-2 text-sm text-red-400">
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
          className="shrink-0 text-neutral-600 hover:text-white"
        >
          {expanded ? "▼" : "▶"}
        </button>
        {expanded ? (
          <pre
            className={`whitespace-pre-wrap break-words select-text ${className ?? "text-neutral-400"}`}
          >
            {text}
          </pre>
        ) : (
          <span
            className={`cursor-pointer truncate font-mono ${className ?? "text-neutral-400"}`}
            onClick={() => {
              const sel = window.getSelection();
              if (sel && sel.toString().length > 0) return;
              setExpanded(true);
            }}
          >
            <span className="text-neutral-600">{label}: </span>
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
    <div className="my-2 border border-neutral-800 p-2 text-sm">
      <div className="font-mono text-yellow-500">{content.name}</div>
      <CollapsiblePre label="params" text={inputStr} className="text-neutral-500" />
      {outputStr && (
        <div className="mt-1 border-t border-neutral-800 pt-1">
          <CollapsiblePre label="result" text={outputStr} className="text-neutral-300" />
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
      <div className={`font-bold ${isUser ? "text-white" : "text-green-400"}`}>
        &gt; {isUser ? "you" : `agent-${group.runId.replace(/-/g, "").slice(-7)}`}
        {isStreaming && (
          <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
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
    <div className="mt-2 border-l border-neutral-700 pl-2 sm:pl-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mb-1 text-xs text-neutral-600 hover:text-white"
      >
        {expanded ? "▼ collapse" : "▶ expand"}
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
            isConnected={false}
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
  isConnected,
  graph,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  isConnected: boolean;
  graph?: Graph;
}) {
  const groups = groupNodes(nodes);
  const representedRunIds = collectRunIds(nodes);
  const activeStreams = isConnected && graph ? getActiveRunIds(graph) : new Set<string>();

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
            <div className="font-bold text-green-400">
              &gt; agent-{runId.replace(/-/g, "").slice(-7)}
              <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
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
    <div className="my-4 border border-neutral-700 p-4">
      <div className="mb-2 font-bold">permission required</div>
      <div className="mb-2 text-sm text-neutral-400">
        tool: <span className="font-mono text-white">{request.tool}</span>
      </div>
      <pre className="mb-4 overflow-x-auto border border-neutral-800 p-2 text-sm text-neutral-400">
        {paramsStr}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={onAllow}
          className="border border-neutral-600 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-900"
        >
          allow
        </button>
        <button
          onClick={onAllowAll}
          className="border border-neutral-600 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-900"
        >
          always allow
        </button>
        <button
          onClick={onDeny}
          className="border border-neutral-600 px-3 py-1 text-sm font-medium text-neutral-500 hover:bg-neutral-900 hover:text-white"
        >
          deny
        </button>
      </div>
    </div>
  );
}

export function ConversationThread({
  graph,
  pendingRelays,
  permissionHandlers,
  isConnected,
}: ConversationThreadProps) {
  const viewNodes = projectThread(graph);
  const activeRunIds = isConnected ? getActiveRunIds(graph) : new Set<string>();

  if (viewNodes.length === 0 && activeRunIds.size === 0) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-600">
        start a conversation below.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Thread
        nodes={viewNodes}
        pendingRelays={pendingRelays}
        permissionHandlers={permissionHandlers}
        isConnected={isConnected}
        graph={graph}
      />
    </div>
  );
}
