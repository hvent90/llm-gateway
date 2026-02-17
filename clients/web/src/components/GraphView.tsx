import { useMemo, useEffect, useRef } from "react";
import type { ConversationGraph } from "../../../../packages/ai/client/hypergraph";
import { projectDAG } from "../../../../packages/ai/client/hypergraph/projections/dag";
import type { PendingRelay } from "../types";
import { usePanZoom } from "../hooks/usePanZoom";
import { DAGNode } from "./graph/DAGNode";
import { DAGEdge } from "./graph/DAGEdge";
import { DAGGroup } from "./graph/DAGGroup";

export interface PermissionHandlers {
  onAllow: (relay: PendingRelay) => void;
  onAllowAll: (relay: PendingRelay) => void;
  onDeny: (relay: PendingRelay) => void;
}

interface GraphViewProps {
  graph: ConversationGraph;
  pendingRelays?: PendingRelay[];
  permissionHandlers?: PermissionHandlers;
}

export function GraphView({ graph, pendingRelays = [], permissionHandlers }: GraphViewProps) {
  const layout = useMemo(() => projectDAG(graph), [graph]);
  const { containerRef, contentRef, scale, zoomToFit } = usePanZoom();
  const hasInitialFit = useRef(false);

  // Build relay lookup: toolCallId → PendingRelay
  const relayByToolCallId = useMemo(() => {
    const map = new Map<string, PendingRelay>();
    for (const r of pendingRelays) map.set(r.toolCallId, r);
    return map;
  }, [pendingRelays]);

  // Build node lookup for edge rendering
  const nodeById = useMemo(() => {
    const map = new Map<string, (typeof layout.nodes)[number]>();
    for (const n of layout.nodes) map.set(n.id, n);
    return map;
  }, [layout]);

  // Initial fit
  useEffect(() => {
    if (!hasInitialFit.current && layout.nodes.length > 0) {
      hasInitialFit.current = true;
      zoomToFit(layout.totalWidth, layout.totalHeight);
    }
  }, [layout, zoomToFit]);

  if (layout.nodes.length === 0) {
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
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <div ref={contentRef}>
        {/* SVG layer: groups + edges (behind nodes) */}
        <svg
          className="absolute left-0 top-0"
          width={layout.totalWidth}
          height={layout.totalHeight}
          style={{ pointerEvents: "none" }}
        >
          <defs>
            <marker
              id="arrowhead"
              viewBox="0 0 10 7"
              refX="10"
              refY="3.5"
              markerWidth="6"
              markerHeight="5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#6b7280" />
            </marker>
          </defs>
          {/* Groups behind everything */}
          {layout.groups.map((group) => (
            <DAGGroup key={group.id} group={group} />
          ))}
          {/* Edges */}
          {layout.edges.map((edge) => {
            const source = nodeById.get(edge.source);
            const target = nodeById.get(edge.target);
            if (!source || !target) return null;
            return (
              <DAGEdge
                key={`${edge.source}-${edge.target}`}
                source={source}
                target={target}
                type={edge.type}
              />
            );
          })}
        </svg>
        {/* HTML node layer */}
        {layout.nodes.map((node) => {
          const relay = relayByToolCallId.get(node.id);
          return (
            <DAGNode
              key={node.id}
              node={node}
              relay={relay}
              onAllow={permissionHandlers?.onAllow}
              onAllowAll={permissionHandlers?.onAllowAll}
              onDeny={permissionHandlers?.onDeny}
            />
          );
        })}
      </div>
      {/* Zoom controls */}
      <button
        className="absolute bottom-3 right-3 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-700 hover:text-white"
        onClick={() => zoomToFit(layout.totalWidth, layout.totalHeight)}
      >
        fit
      </button>
      <div className="absolute bottom-3 right-14 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400">
        {Math.round(scale * 100)}%
      </div>
    </div>
  );
}
