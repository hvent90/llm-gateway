interface DAGGroupProps {
  group: {
    id: string;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    borderColor: string;
    edgeType: "message" | "summary";
  };
}

export function DAGGroup({ group }: DAGGroupProps) {
  return (
    <g>
      <rect
        x={group.x}
        y={group.y}
        width={group.width}
        height={group.height}
        rx={6}
        fill={group.color}
        stroke={group.borderColor}
        strokeWidth={1}
        strokeDasharray={group.edgeType === "summary" ? "4 4" : undefined}
      />
      <text x={group.x + 8} y={group.y - 4} fill="#9ca3af" fontSize={11}>
        {group.label}
      </text>
    </g>
  );
}
