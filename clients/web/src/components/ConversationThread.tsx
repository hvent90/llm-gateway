import React, { useState, memo, useCallback } from "react";
import { Streamdown } from "streamdown";
import {
  projectThread,
  walk,
  deriveMessageContent,
  sourcesOf,
  summariesOf,
} from "../../../../packages/ai/client/hypergraph";
import type {
  ViewNode,
  ViewContent,
  ConversationGraph,
  PendingRelay,
  NodeId,
  Message,
} from "../types";
import type { ExecProgressState } from "../../../../packages/ai/rlm/exec-progress";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface ConversationThreadProps {
  graph: ConversationGraph;
  active: Set<NodeId>;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  onSummarize: (sourceIds: string[], messages: Message[]) => void;
  onExpand: (nodeId: string) => void;
  onCollapse: (nodeIds: string[]) => void;
  isSummarizing: boolean;
}

interface MessageGroup {
  runId: string;
  role: "user" | "assistant";
  nodes: ViewNode[];
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
      return (
        <div className="mt-1 whitespace-pre-wrap">
          {typeof content.content === "string"
            ? content.content
            : content.content
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("\n")}
        </div>
      );
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
    case "pending":
      return null;
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
  const [expanded, setExpanded] = useState(false);
  const inputStr =
    typeof content.input === "string" ? content.input : JSON.stringify(content.input, null, 2);
  const outputStr =
    content.output !== undefined
      ? typeof content.output === "string"
        ? content.output
        : JSON.stringify(content.output, null, 2)
      : null;
  const progress = content.progress as ExecProgressState | null;
  const paramsOneLine =
    typeof content.input === "string"
      ? content.input.replace(/\n/g, " ")
      : JSON.stringify(content.input).replace(/,/g, ", ");

  return (
    <div className="my-1 border border-neutral-800 text-sm">
      <div
        className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-neutral-900"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="shrink-0 text-neutral-600">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono text-yellow-500">{content.name}</span>
        {!expanded && (
          <span className="min-w-0 flex-1 truncate font-mono text-neutral-500">
            {paramsOneLine}
          </span>
        )}
        {!expanded && progress && !outputStr && (
          <span className="shrink-0 text-neutral-600 text-xs">
            {progress.metrics ? `${(progress.metrics.wallMs / 1000).toFixed(1)}s` : "…"}
          </span>
        )}
      </div>
      {expanded && (
        <div className="border-t border-neutral-800 px-2 py-1">
          <CollapsiblePre label="params" text={inputStr} className="text-neutral-500" />
          {outputStr && (
            <div className="mt-1 border-t border-neutral-800 pt-1">
              <CollapsiblePre label="result" text={outputStr} className="text-neutral-300" />
            </div>
          )}
          {progress && (progress.stdout || progress.stderr) && (
            <div className="mt-1 border-t border-neutral-800 pt-1">
              {progress.stdout && (
                <div className="flex max-h-40 flex-col-reverse overflow-y-auto">
                  <pre className="whitespace-pre-wrap text-xs text-neutral-400">
                    {progress.stdout}
                  </pre>
                </div>
              )}
              {progress.stderr && (
                <div className="flex max-h-40 flex-col-reverse overflow-y-auto">
                  <pre className="whitespace-pre-wrap text-xs text-red-400">{progress.stderr}</pre>
                </div>
              )}
            </div>
          )}
          {progress?.metrics && (
            <div className="mt-1 border-t border-neutral-800 pt-1 text-xs text-neutral-600">
              CPU: {progress.metrics.cpuPercent.toFixed(1)}% · RSS:{" "}
              {(progress.metrics.rssKb / 1024).toFixed(1)}MB ·{" "}
              {(progress.metrics.wallMs / 1000).toFixed(1)}s
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const MessageGroupComponent = memo(function MessageGroupComponent({
  group,
  pendingRelays,
  permissionHandlers,
  messageId,
  selected,
  anySelected,
  onToggleSelect,
  graph,
  onExpand,
}: {
  group: MessageGroup;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  messageId?: string;
  selected: boolean;
  anySelected: boolean;
  onToggleSelect: (shiftKey: boolean) => void;
  graph?: ConversationGraph;
  onExpand?: (nodeId: string) => void;
}) {
  const isUser = group.role === "user";
  const isStreaming = group.nodes.some((n) => n.status === "streaming");
  const groupRelays = pendingRelays.filter((r) => r.runId === group.runId);

  const sources = messageId && graph ? sourcesOf(graph, messageId) : [];
  const isSummary = sources.length > 0;

  return (
    <div
      className={`group relative mb-4 pl-6 ${isSummary ? "border-l-2 border-dashed border-blue-800 pl-10" : ""}`}
    >
      {messageId && (
        <div
          className={`absolute left-0 top-0 flex h-6 w-6 items-center justify-center ${
            anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          } transition-opacity`}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) =>
              onToggleSelect(e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey)
            }
            className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
          />
        </div>
      )}
      {isSummary && messageId && (
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs text-blue-400">Summary</span>
          <button
            type="button"
            onClick={() => onExpand?.(messageId)}
            className="text-xs text-neutral-500 hover:text-white"
          >
            show {sources.length} original messages
          </button>
        </div>
      )}
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

  const agentLabel = `agent-${branch[0]!.runId.replace(/-/g, "").slice(-7)}`;

  return (
    <div className="mt-2 border-l-4 border-neutral-700 pl-2 sm:pl-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mb-1 text-xs text-neutral-600 hover:text-white"
      >
        {expanded ? "▼" : "▶"} <span className="text-green-700">{agentLabel}</span>
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
          />
        </div>
      </div>
      {expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-xs text-neutral-600 hover:text-white"
        >
          ▲ collapse
        </button>
      )}
    </div>
  );
}

function Thread({
  nodes,
  pendingRelays,
  permissionHandlers,
  messageIds,
  selectedIds,
  anySelected,
  onToggleSelect,
  lastSelectedGroupIndex,
  onSummarizeClick,
  onClearSelection,
  isSummarizing,
  graph,
  onExpand,
  onCollapse,
}: {
  nodes: ViewNode[];
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
  messageIds?: string[];
  selectedIds?: Set<string>;
  anySelected?: boolean;
  onToggleSelect?: (index: number, shiftKey: boolean) => void;
  lastSelectedGroupIndex?: number;
  onSummarizeClick?: () => void;
  onClearSelection?: () => void;
  isSummarizing?: boolean;
  graph?: ConversationGraph;
  onExpand?: (nodeId: string) => void;
  onCollapse?: (nodeIds: string[]) => void;
}) {
  const groups = groupNodes(nodes);

  return (
    <>
      {groups.map((group, i) => {
        const msgId = messageIds?.[i];

        // Determine if this is the last source message of a summary (for collapse button)
        let isLastSource = false;
        let collapseSourceIds: string[] = [];
        if (msgId && graph) {
          const sums = summariesOf(graph, msgId);
          if (sums.length > 0) {
            const sumSources = sourcesOf(graph, sums[0]!);
            const nextMsgId = messageIds?.[i + 1];
            isLastSource = !nextMsgId || !sumSources.includes(nextMsgId);
            if (isLastSource) {
              collapseSourceIds = sumSources;
            }
          }
        }

        return (
          <React.Fragment key={`${group.runId}-${group.nodes[0]!.id}`}>
            <MessageGroupComponent
              group={group}
              pendingRelays={pendingRelays}
              permissionHandlers={permissionHandlers}
              messageId={msgId}
              selected={msgId ? (selectedIds?.has(msgId) ?? false) : false}
              anySelected={anySelected ?? false}
              onToggleSelect={(shiftKey: boolean) => onToggleSelect?.(i, shiftKey)}
              graph={graph}
              onExpand={onExpand}
            />
            {isLastSource && collapseSourceIds.length > 0 && (
              <button
                type="button"
                onClick={() => onCollapse?.(collapseSourceIds)}
                className="my-1 text-xs text-neutral-500 hover:text-white"
              >
                ▲ collapse to summary
              </button>
            )}
            {i === lastSelectedGroupIndex && selectedIds && selectedIds.size > 0 && (
              <div className="my-2 flex items-center gap-2 pl-6">
                <button
                  type="button"
                  onClick={onSummarizeClick}
                  disabled={isSummarizing}
                  className="border border-blue-800 bg-blue-950 px-3 py-1 text-sm text-blue-300 hover:bg-blue-900 disabled:opacity-50"
                >
                  {isSummarizing ? "summarizing..." : `summarize ${selectedIds.size} messages`}
                </button>
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="px-2 py-1 text-sm text-neutral-500 hover:text-white"
                >
                  cancel
                </button>
              </div>
            )}
          </React.Fragment>
        );
      })}
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
  const paramsOneLine = JSON.stringify(request.params).replace(/,/g, ", ");

  return (
    <div className="my-1 flex items-center gap-2 border border-neutral-700 px-2 py-1 text-sm">
      <span className="font-mono text-yellow-500">{request.tool}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-neutral-500">{paramsOneLine}</span>
      <span className="flex shrink-0 gap-1">
        <button
          onClick={onAllow}
          className="border border-neutral-600 px-2 py-0.5 text-xs text-white hover:bg-neutral-900"
        >
          allow
        </button>
        <button
          onClick={onAllowAll}
          className="border border-neutral-600 px-2 py-0.5 text-xs text-white hover:bg-neutral-900"
        >
          always
        </button>
        <button
          onClick={onDeny}
          className="border border-neutral-600 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-white"
        >
          deny
        </button>
      </span>
    </div>
  );
}

export function ConversationThread({
  graph,
  active,
  pendingRelays,
  permissionHandlers,
  onSummarize,
  onExpand,
  onCollapse,
  isSummarizing,
}: ConversationThreadProps) {
  const viewNodes = projectThread(graph);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  const messageIds = [...walk(graph, active)].map((n) => n.id);

  const handleToggleSelect = useCallback(
    (index: number, shiftKey: boolean) => {
      const msgId = messageIds[index];
      if (!msgId) return;

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (shiftKey && lastClickedIndex !== null) {
          const start = Math.min(lastClickedIndex, index);
          const end = Math.max(lastClickedIndex, index);
          for (let i = start; i <= end; i++) {
            const id = messageIds[i];
            if (id) next.add(id);
          }
        } else if (next.has(msgId)) {
          next.delete(msgId);
        } else {
          next.add(msgId);
        }
        return next;
      });
      setLastClickedIndex(index);
    },
    [messageIds, lastClickedIndex],
  );

  const handleSummarizeClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    const sourceIds = [...selectedIds];
    const messages: Message[] = [];
    for (const id of sourceIds) {
      messages.push(...deriveMessageContent(graph, id));
    }
    onSummarize(sourceIds, messages);
    setSelectedIds(new Set());
    setLastClickedIndex(null);
  }, [selectedIds, graph, onSummarize]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastClickedIndex(null);
  }, []);

  const lastSelectedGroupIndex = messageIds.reduce(
    (last: number, id: string, i: number) => (selectedIds.has(id) ? i : last),
    -1,
  );

  if (viewNodes.length === 0) {
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
        messageIds={messageIds}
        selectedIds={selectedIds}
        anySelected={selectedIds.size > 0}
        onToggleSelect={handleToggleSelect}
        lastSelectedGroupIndex={lastSelectedGroupIndex}
        onSummarizeClick={handleSummarizeClick}
        onClearSelection={handleClearSelection}
        isSummarizing={isSummarizing}
        graph={graph}
        onExpand={onExpand}
        onCollapse={onCollapse}
      />
    </div>
  );
}
