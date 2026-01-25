import type { MessageNode as MessageNodeType, ToolCall } from "../types";

interface MessageNodeProps {
  node: MessageNodeType;
  depth?: number;
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCall }) {
  const inputStr =
    typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input, null, 2);

  const outputStr =
    toolCall.output !== undefined
      ? typeof toolCall.output === "string"
        ? toolCall.output
        : JSON.stringify(toolCall.output, null, 2)
      : null;

  return (
    <div className="my-2 rounded border border-gray-700 bg-gray-800 p-2 text-sm">
      <div className="font-mono text-yellow-400">🔧 {toolCall.name}</div>
      <pre className="mt-1 overflow-x-auto text-gray-400">{inputStr}</pre>
      {outputStr && (
        <div className="mt-2 border-t border-gray-700 pt-2">
          <span className="text-gray-500">↳ </span>
          <pre className="inline overflow-x-auto text-gray-300">{outputStr}</pre>
        </div>
      )}
    </div>
  );
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

export function MessageNode({ node, depth = 0 }: MessageNodeProps) {
  const isUser = node.role === "user";
  const indent = indentClasses[Math.min(depth, 4)] ?? "ml-16";

  return (
    <div className={`${indent} mb-4`}>
      {/* Header */}
      <div className={`font-medium ${isUser ? "text-blue-400" : "text-green-400"}`}>
        {isUser ? "You" : `Agent-${node.agentId.slice(0, 8)}`}
      </div>

      {/* Reasoning */}
      {node.reasoning.length > 0 && (
        <div className="mt-1 text-sm italic text-gray-500">💭 {node.reasoning.join("")}</div>
      )}

      {/* Tool calls */}
      {node.toolCalls.map((tc) => (
        <ToolCallBlock key={tc.id} toolCall={tc} />
      ))}

      {/* Content */}
      {node.content && <div className="mt-1 whitespace-pre-wrap text-gray-200">{node.content}</div>}

      {/* Children (subagents) */}
      {node.children.length > 0 && (
        <div className="mt-2 border-l-2 border-gray-700 pl-2 sm:pl-4">
          {node.children.map((child) => (
            <MessageNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
