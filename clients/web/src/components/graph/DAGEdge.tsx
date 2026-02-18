import type { DAGNodeData } from "./DAGNode";

interface DAGEdgeProps {
  source: DAGNodeData;
  target: DAGNodeData;
  type: "sequence" | "spawn";
}

export function DAGEdge({ source, target, type }: DAGEdgeProps) {
  // Sequence: vertical line from bottom-center of source to top-center of target
  // Spawn: L-shaped path from right side of source to top-center of target
  const sx = type === "spawn" ? source.x + source.width : source.x + source.width / 2;
  const sy = type === "spawn" ? source.y + source.height / 2 : source.y + source.height;
  const tx = target.x + target.width / 2;
  const ty = target.y;

  let d: string;
  if (type === "spawn") {
    // L-shaped: go right, then down
    const midX = tx;
    d = `M${sx},${sy} L${midX},${sy} L${midX},${ty}`;
  } else {
    // Straight vertical (or slight S-curve if not aligned)
    if (Math.abs(sx - tx) < 1) {
      d = `M${sx},${sy} L${tx},${ty}`;
    } else {
      const midY = (sy + ty) / 2;
      d = `M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}`;
    }
  }

  return (
    <path
      d={d}
      fill="none"
      stroke={type === "spawn" ? "#ec4899aa" : "#6b7280aa"}
      strokeWidth={1.5}
      strokeDasharray={type === "spawn" ? "4 4" : undefined}
      markerEnd="url(#arrowhead)"
    />
  );
}
