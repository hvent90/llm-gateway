import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ConversationGraph, NodeId } from "../../../../packages/ai/client/hypergraph";
import {
  defaultActive,
  expand,
  collapse,
  findEdges,
  blocksOf,
  chunksOf,
} from "../../../../packages/ai/client/hypergraph";
import {
  projectForceGraph,
  type ForceNode,
  type ForceHull,
} from "../../../../packages/ai/client/hypergraph/projections/force-graph";
import { convexHull, paddedHullPath } from "../lib/convex-hull";

interface GraphViewProps {
  graph: ConversationGraph;
}

export function GraphView({ graph }: GraphViewProps) {
  const [active, setActive] = useState<Set<NodeId>>(() => defaultActive(graph));
  const [hoveredNode, setHoveredNode] = useState<ForceNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });
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

  // Incrementally add new message nodes to active set without resetting expand/collapse state
  const knownMessagesRef = useRef(new Set<string>());

  useEffect(() => {
    const currentMessages = new Set<string>();
    for (const [id, node] of graph.nodes) {
      if (node.kind === "message") currentMessages.add(id);
    }

    const newMessages: string[] = [];
    for (const id of currentMessages) {
      if (!knownMessagesRef.current.has(id)) newMessages.push(id);
    }

    if (knownMessagesRef.current.size === 0) {
      setActive(defaultActive(graph));
    } else if (newMessages.length > 0) {
      setActive((prev) => {
        const next = new Set(prev);
        for (const id of newMessages) next.add(id as NodeId);
        return next;
      });
    }

    knownMessagesRef.current = currentMessages;
  }, [graph]);

  const data = useMemo(() => projectForceGraph(graph, active), [graph, active]);

  const handleNodeClick = useCallback(
    (node: ForceNode) => {
      if (node.kind === "message" || node.kind === "block") {
        setActive((prev) => expand(graph, prev, node.id as NodeId));
      } else {
        // Chunk click — try to collapse back to block
        const blockEdges = findEdges(graph, {
          type: "block",
          node: node.id as NodeId,
          role: "part",
        });
        if (blockEdges.length > 0) {
          const parts = blockEdges[0]!.roles.part;
          setActive((prev) => collapse(graph, prev, parts));
        }
      }
    },
    [graph],
  );

  const handleNodeHover = useCallback((node: ForceNode | null) => {
    setHoveredNode(node);
    setTooltipPos(node ? { ...mousePosRef.current } : null);
    const canvas = containerRef.current?.querySelector("canvas");
    if (canvas) canvas.style.cursor = node ? "pointer" : "default";
  }, []);

  const drawNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const forceNode = node as ForceNode & { x: number; y: number };
      const size = forceNode.size / globalScale;

      ctx.beginPath();
      ctx.arc(forceNode.x, forceNode.y, size, 0, Math.PI * 2);
      ctx.fillStyle = forceNode.color;
      ctx.fill();

      // Border for hovered node
      if (hoveredNode?.id === forceNode.id) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      // Label at sufficient zoom
      if (globalScale > 2) {
        ctx.fillStyle = "#e5e7eb";
        ctx.font = `${10 / globalScale}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(forceNode.label, forceNode.x, forceNode.y + size + 12 / globalScale);
      }
    },
    [hoveredNode],
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

        if (points.length < 2) continue;

        const padding = 20 / globalScale;
        const path = paddedHullPath(points, padding);

        ctx.fillStyle = hull.color;
        ctx.fill(path);

        if (hull.edgeType === "summary") {
          ctx.setLineDash([4 / globalScale, 4 / globalScale]);
          ctx.strokeStyle = "#a78bfa";
          ctx.lineWidth = 1 / globalScale;
          ctx.stroke(path);
          ctx.setLineDash([]);
        }
      }
    },
    [data],
  );

  const linkColor = useCallback((link: any) => {
    return link.type === "spawn" ? "#ec489966" : "#6b728066";
  }, []);

  const linkDashArray = useCallback((link: any) => {
    return link.dashed ? [4, 4] : undefined;
  }, []);

  const paintPointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const forceNode = node as ForceNode & { x: number; y: number };
      const size = forceNode.size / globalScale;
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
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onEngineStop={handleEngineStop}
        linkColor={linkColor}
        linkLineDash={linkDashArray}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        backgroundColor="transparent"
        cooldownTicks={50}
        nodeId="id"
        nodeRelSize={1}
      />
      <button
        className="absolute bottom-3 right-3 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700 hover:text-white"
        onClick={() => graphRef.current?.zoomToFit(400, 40)}
      >
        fit
      </button>
      {hoveredNode && tooltipPos && (
        <div
          className="pointer-events-none absolute z-10 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300"
          style={{
            left: Math.min(tooltipPos.x + 12, dimensions.width - 200),
            top: Math.min(tooltipPos.y + 12, dimensions.height - 80),
          }}
        >
          <div className="font-bold">{hoveredNode.kind}</div>
          <div className="mt-1">{hoveredNode.label}</div>
          <div className="mt-1 text-neutral-500">
            {hoveredNode.kind === "chunk" ? "click to collapse" : "click to expand"}
          </div>
        </div>
      )}
    </div>
  );
}
