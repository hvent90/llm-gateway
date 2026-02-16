import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ConversationGraph } from "../../../../packages/ai/client/hypergraph";
import {
  projectForceGraph,
  type ForceNode,
  type ForceHull,
} from "../../../../packages/ai/client/hypergraph/projections/force-graph";
import { paddedHullPath } from "../lib/convex-hull";

interface GraphViewProps {
  graph: ConversationGraph;
}

// Higher-opacity border colors for hull outlines
function hullBorderColor(hull: ForceHull): string {
  if (hull.edgeType === "summary") return "#a78bfa";
  if (hull.level === "block") {
    // Derive a more opaque version from the fill color
    if (hull.color.includes("59,130,246")) return "rgba(59,130,246,0.4)";
    if (hull.color.includes("249,115,22")) return "rgba(249,115,22,0.4)";
    if (hull.color.includes("34,197,94")) return "rgba(34,197,94,0.4)";
    if (hull.color.includes("239,68,68")) return "rgba(239,68,68,0.4)";
    return "rgba(107,114,128,0.4)";
  }
  // Message hull border
  if (hull.color.includes("34,197,94")) return "rgba(34,197,94,0.2)";
  return "rgba(59,130,246,0.2)";
}

export function GraphView({ graph }: GraphViewProps) {
  const [hoveredNode, setHoveredNode] = useState<ForceNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const hoveredNodeRef = useRef<ForceNode | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => projectForceGraph(graph), [graph]);

  // Force simulation tuning
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const charge = fg.d3Force("charge");
    if (charge) charge.strength(-30);
  }, [data]);

  const handleNodeHover = useCallback((node: ForceNode | null) => {
    hoveredNodeRef.current = node;
    setHoveredNode(node);
    setTooltipPos(node ? { ...mousePosRef.current } : null);
    const canvas = containerRef.current?.querySelector("canvas");
    if (canvas) canvas.style.cursor = node ? "default" : "default";
  }, []);

  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const forceNode = node as ForceNode & { x: number; y: number };
    const size = 4 / globalScale;

    ctx.beginPath();
    ctx.arc(forceNode.x, forceNode.y, size, 0, Math.PI * 2);
    ctx.fillStyle = forceNode.color;
    ctx.fill();

    // Border for hovered node
    if (hoveredNodeRef.current?.id === forceNode.id) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // Label — show chunks at high zoom
    if (globalScale > 2.0) {
      ctx.fillStyle = "#e5e7eb";
      ctx.font = `${10 / globalScale}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(forceNode.label, forceNode.x, forceNode.y + size + 12 / globalScale);
    }
  }, []);

  const drawHulls = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      const nodePositions = new Map<string, { x: number; y: number }>();
      for (const node of data.nodes as Array<ForceNode & { x?: number; y?: number }>) {
        if (node.x !== undefined && node.y !== undefined) {
          nodePositions.set(node.id, { x: node.x, y: node.y });
        }
      }

      for (const hull of data.hulls) {
        const points = hull.nodeIds
          .map((id) => nodePositions.get(id))
          .filter((p): p is { x: number; y: number } => p !== undefined);

        if (points.length === 0) continue;

        const padding = hull.padding / globalScale;
        const path = paddedHullPath(points, padding);

        // Fill
        ctx.fillStyle = hull.color;
        ctx.fill(path);

        // Border
        if (hull.edgeType === "summary") {
          ctx.setLineDash([4 / globalScale, 4 / globalScale]);
        }
        ctx.strokeStyle = hullBorderColor(hull);
        ctx.lineWidth = 1 / globalScale;
        ctx.stroke(path);
        if (hull.edgeType === "summary") {
          ctx.setLineDash([]);
        }

        // Hull label
        const showLabel =
          (hull.level === "message" && globalScale > 0.8) ||
          (hull.level === "block" && globalScale > 1.5);

        if (showLabel && points.length > 0) {
          const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
          const cy = Math.min(...points.map((p) => p.y)) - padding - 4 / globalScale;
          ctx.fillStyle = hull.level === "message" ? "#9ca3af" : "#d1d5db";
          ctx.font = `${(hull.level === "message" ? 11 : 9) / globalScale}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(hull.label, cx, cy);
        }
      }
    },
    [data],
  );

  const linkColor = useCallback((link: any) => {
    return link.type === "spawn" ? "#ec4899aa" : "#6b7280aa";
  }, []);

  const linkDashArray = useCallback((link: any) => {
    return link.dashed ? [4, 4] : undefined;
  }, []);

  const linkDistance = useCallback((link: any) => {
    return link.type === "spawn" ? 80 : 30;
  }, []);

  const paintPointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const forceNode = node as ForceNode & { x: number; y: number };
      const size = 4 / globalScale;
      ctx.beginPath();
      ctx.arc(forceNode.x, forceNode.y, size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
  }, []);

  const handleEngineStop = useCallback(() => {
    graphRef.current?.zoomToFit(400, 40);
  }, []);

  if (data.nodes.length === 0) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full items-center justify-center text-neutral-600"
      >
        send a message to see the graph
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full" onMouseMove={handleMouseMove}>
      <ForceGraph2D
        ref={graphRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={{ nodes: data.nodes as any[], links: data.links as any[] }}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={paintPointerArea}
        onRenderFramePost={drawHulls}
        onNodeHover={handleNodeHover}
        onEngineStop={handleEngineStop}
        linkColor={linkColor}
        linkLineDash={linkDashArray}
        linkWidth={1.5}
        linkDirectionalArrowLength={6}
        linkDirectionalArrowRelPos={1}
        linkDistance={linkDistance}
        autoPauseRedraw={false}
        backgroundColor="transparent"
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        cooldownTicks={100}
        nodeId="id"
        nodeRelSize={1}
      />
      <button
        className="absolute bottom-3 right-3 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700 hover:text-white"
        onClick={() => graphRef.current?.zoomToFit(400, 40)}
      >
        fit
      </button>
      <div className="absolute bottom-3 left-3 rounded border border-neutral-800 bg-neutral-900/90 px-3 py-2 text-xs text-neutral-400">
        <div className="mb-1 text-neutral-500">chunks</div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#3b82f6" }} />
          text
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#f97316" }} />
          tool call
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#f59e0b" }} />
          tool result
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#22c55e" }} />
          user
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#8b5cf6" }} />
          reasoning
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#6b7280" }} />
          structural
        </div>
        <div className="mt-1.5 border-t border-neutral-800 pt-1.5 text-neutral-500">regions</div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ background: "rgba(59,130,246,0.18)" }}
          />
          block
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-3 rounded-sm"
            style={{ background: "rgba(59,130,246,0.08)" }}
          />
          message
        </div>
        <div className="mt-1.5 border-t border-neutral-800 pt-1.5 text-neutral-500">links</div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3" style={{ background: "#6b7280" }} />
          sequence
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3 border-b border-dashed"
            style={{ borderColor: "#ec4899" }}
          />
          spawn
        </div>
      </div>
      {hoveredNode && tooltipPos && (
        <div
          className="pointer-events-none absolute z-10 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300"
          style={{
            left: Math.min(tooltipPos.x + 12, dimensions.width - 200),
            top: Math.min(tooltipPos.y + 12, dimensions.height - 80),
          }}
        >
          <div className="font-bold">{hoveredNode.label}</div>
          <div className="mt-1 text-neutral-500">{hoveredNode.kind}</div>
        </div>
      )}
    </div>
  );
}
