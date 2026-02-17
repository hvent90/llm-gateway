import type { PendingRelay } from "../../types";

export interface DAGNodeData {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blockType: string;
  label: string;
  color: string;
  borderColor: string;
}

interface DAGNodeProps {
  node: DAGNodeData;
  relay?: PendingRelay;
  onAllow?: (relay: PendingRelay) => void;
  onAllowAll?: (relay: PendingRelay) => void;
  onDeny?: (relay: PendingRelay) => void;
}

export function DAGNode({ node, relay, onAllow, onAllowAll, onDeny }: DAGNodeProps) {
  return (
    <div
      data-dag-node
      className="absolute select-text overflow-hidden rounded"
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        minHeight: node.height,
        backgroundColor: node.color,
        borderWidth: relay ? 2 : 1,
        borderStyle: "solid",
        borderColor: relay ? "#f59e0b" : node.borderColor,
        boxShadow: relay ? "0 0 8px rgba(245,158,11,0.4)" : undefined,
      }}
    >
      <div className="px-2 py-0.5 text-[10px]" style={{ color: node.borderColor }}>
        {node.blockType}
      </div>
      <div
        className="px-2 pb-1.5 font-mono text-xs text-neutral-200"
        style={{ wordBreak: "break-word" }}
      >
        {node.label.length > 300 ? node.label.slice(0, 300) + "..." : node.label}
      </div>
      {relay && (
        <div className="flex gap-1 border-t border-neutral-700 px-2 py-1.5">
          <button
            className="rounded bg-green-800 px-2 py-0.5 text-[10px] text-green-200 hover:bg-green-700 active:bg-green-700"
            onClick={() => onAllow?.(relay)}
          >
            Allow
          </button>
          <button
            className="rounded bg-blue-800 px-2 py-0.5 text-[10px] text-blue-200 hover:bg-blue-700 active:bg-blue-700"
            onClick={() => onAllowAll?.(relay)}
          >
            Allow All
          </button>
          <button
            className="rounded bg-red-900 px-2 py-0.5 text-[10px] text-red-200 hover:bg-red-800 active:bg-red-800"
            onClick={() => onDeny?.(relay)}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
