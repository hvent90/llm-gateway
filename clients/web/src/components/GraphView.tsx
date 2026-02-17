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

  // Memoize graphData object to prevent simulation reheats on re-render
  const graphData = useMemo(
    () => ({ nodes: data.nodes as any[], links: data.links as any[] }),
    [data],
  );

  // Force simulation tuning — more repulsion for larger rectangular nodes
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const charge = fg.d3Force("charge");
    if (charge) charge.strength(-80);
  }, [data]);

  const handleNodeHover = useCallback((node: ForceNode | null) => {
    hoveredNodeRef.current = node;
    // Batch tooltip state updates into a single render
    if (node) {
      setTooltipPos({ ...mousePosRef.current });
      setHoveredNode(node);
    } else {
      setHoveredNode(null);
      setTooltipPos(null);
    }
  }, []);

  // Draw block nodes as rounded rectangles with text content
  const drawNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const forceNode = node as ForceNode & { x: number; y: number };
      const w = forceNode.width / globalScale;
      const h = forceNode.height / globalScale;
      const x = forceNode.x - w / 2;
      const y = forceNode.y - h / 2;
      const r = 4 / globalScale; // corner radius

      // Draw rounded rectangle
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();

      // Fill
      ctx.fillStyle = forceNode.color;
      ctx.fill();

      // Border
      ctx.strokeStyle =
        hoveredNodeRef.current?.id === forceNode.id ? "#ffffff" : forceNode.borderColor;
      ctx.lineWidth = (hoveredNodeRef.current?.id === forceNode.id ? 2 : 1) / globalScale;
      ctx.stroke();

      // Type indicator in top-left
      const typeFontSize = Math.max(7 / globalScale, 0.5);
      ctx.fillStyle = forceNode.borderColor;
      ctx.font = `${typeFontSize}px sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(forceNode.blockType, x + 4 / globalScale, y + 3 / globalScale);

      // Text content with wrapping
      const fontSize = Math.max(9 / globalScale, 0.8);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = `${fontSize}px monospace`;
      ctx.textBaseline = "top";

      const padX = 6 / globalScale;
      const textTop = y + 14 / globalScale;
      const maxTextWidth = w - padX * 2;
      const lineHeight = 12 / globalScale;
      const maxLines = Math.floor((h - 16 / globalScale) / lineHeight);

      // Word-wrap the label
      const words = forceNode.label.split(/(\s+)/);
      let line = "";
      let lineNum = 0;
      for (const word of words) {
        const test = line + word;
        if (ctx.measureText(test).width > maxTextWidth && line.length > 0) {
          if (lineNum >= maxLines - 1) {
            ctx.fillText(line.trimEnd() + "...", x + padX, textTop + lineNum * lineHeight);
            lineNum++;
            break;
          }
          ctx.fillText(line.trimEnd(), x + padX, textTop + lineNum * lineHeight);
          lineNum++;
          line = word;
        } else {
          line = test;
        }
      }
      if (lineNum < maxLines && line.length > 0) {
        ctx.fillText(line.trimEnd(), x + padX, textTop + lineNum * lineHeight);
      }
    },
    [], // no deps — uses hoveredNodeRef
  );

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
        if (globalScale > 0.8 && points.length > 0) {
          const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
          const cy = Math.min(...points.map((p) => p.y)) - padding - 4 / globalScale;
          ctx.fillStyle = "#9ca3af";
          ctx.font = `${11 / globalScale}px sans-serif`;
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
    return link.type === "spawn" ? 120 : 50;
  }, []);

  // Rectangular hit area matching the node box
  const paintPointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const forceNode = node as ForceNode & { x: number; y: number };
      const w = forceNode.width / globalScale;
      const h = forceNode.height / globalScale;
      ctx.fillStyle = color;
      ctx.fillRect(forceNode.x - w / 2, forceNode.y - h / 2, w, h);
    },
    [],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
  }, []);

  // Only zoomToFit on initial settle or when data changes — not on every reheat
  const hasSettledRef = useRef(false);
  const dataIdRef = useRef(data);
  if (dataIdRef.current !== data) {
    dataIdRef.current = data;
    hasSettledRef.current = false;
  }
  const handleEngineStop = useCallback(() => {
    if (!hasSettledRef.current) {
      hasSettledRef.current = true;
      graphRef.current?.zoomToFit(400, 40);
    }
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
        graphData={graphData}
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
        <div className="mb-1 text-neutral-500">nodes</div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border"
            style={{ background: "#1e3a5f", borderColor: "#3b82f6" }}
          />
          text
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border"
            style={{ background: "#4a2a0a", borderColor: "#f97316" }}
          />
          tool call
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border"
            style={{ background: "#3d2a05", borderColor: "#f59e0b" }}
          />
          tool result
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border"
            style={{ background: "#0a3d1f", borderColor: "#22c55e" }}
          />
          user
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border"
            style={{ background: "#2d1f5e", borderColor: "#8b5cf6" }}
          />
          reasoning
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm border"
            style={{ background: "#1f2937", borderColor: "#4b5563" }}
          />
          structural
        </div>
        <div className="mt-1.5 border-t border-neutral-800 pt-1.5 text-neutral-500">regions</div>
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
          <div className="mt-1 text-neutral-500">{hoveredNode.blockType}</div>
        </div>
      )}
    </div>
  );
}
