import { getContentBlocks, getChildren, getRole } from "../../../../packages/ai/client";
import type { ContentBlock, GraphState, PendingRelay } from "../types";
import { PermissionPrompt } from "./PermissionPrompt";
import type { PermissionHandlers } from "./ConversationThread";

interface MessageNodeProps {
  graph: GraphState;
  runId: string;
  depth?: number;
  pendingRelays: PendingRelay[];
  permissionHandlers: PermissionHandlers;
}

function ToolCallBlock({ block }: { block: Extract<ContentBlock, { type: "tool_call" }> }) {
  const inputStr =
    typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2);

  const outputStr =
    block.output !== undefined
      ? typeof block.output === "string"
        ? block.output
        : JSON.stringify(block.output, null, 2)
      : null;

  return (
    <div className="my-2 rounded border border-gray-700 bg-gray-800 p-2 text-sm">
      <div className="font-mono text-yellow-400">🔧 {block.name}</div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-gray-400">{inputStr}</pre>
      {outputStr && (
        <div className="mt-2 border-t border-gray-700 pt-2">
          <span className="text-gray-500">↳ </span>
          <pre className="whitespace-pre-wrap break-words text-gray-300">{outputStr}</pre>
        </div>
      )}
    </div>
  );
}

function ContentBlockView({ block, index }: { block: ContentBlock; index: number }) {
  switch (block.type) {
    case "reasoning":
      return (
        <div key={index} className="mt-1 text-sm italic text-gray-500">
          💭 {block.content}
        </div>
      );
    case "tool_call":
      return <ToolCallBlock key={block.id} block={block} />;
    case "text":
      return (
        <div key={index} className="mt-1 whitespace-pre-wrap text-gray-200">
          {block.content}
        </div>
      );
  }
}

// Tailwind needs static class names for purge - can't use dynamic `ml-${n}`
// Use smaller indentation on mobile (ml-2) and larger on desktop (sm:ml-4)
const indentClasses = [
  "",
  "ml-2 sm:ml-4",
  "ml-4 sm:ml-8",
  "ml-6 sm:ml-12",
  "ml-8 sm:ml-16",
] as const;

export function MessageNode({
  graph,
  runId,
  depth = 0,
  pendingRelays,
  permissionHandlers,
}: MessageNodeProps) {
  const role = getRole(graph, runId);
  const blocks = getContentBlocks(graph, runId);
  const children = getChildren(graph, runId);
  const isUser = role === "user";
  const indent = indentClasses[Math.min(depth, 4)] ?? "ml-16";
  const nodeRelays = pendingRelays.filter((r) => r.runId === runId);

  return (
    <div className={`${indent} mb-4`}>
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${runId.slice(0, 8)}`}
      </div>
      {blocks.map((block, index) => (
        <ContentBlockView key={index} block={block} index={index} />
      ))}
      {nodeRelays.map((relay) => (
        <PermissionPrompt
          key={relay.relayId}
          request={relay}
          onAllow={() => permissionHandlers.onAllow(relay)}
          onAllowAll={() => permissionHandlers.onAllowAll(relay)}
          onDeny={() => permissionHandlers.onDeny(relay)}
        />
      ))}
      {children.length > 0 && (
        <div className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
          {children.map((childId) => (
            <MessageNode
              key={childId}
              graph={graph}
              runId={childId}
              depth={depth + 1}
              pendingRelays={pendingRelays}
              permissionHandlers={permissionHandlers}
            />
          ))}
        </div>
      )}
    </div>
  );
}
