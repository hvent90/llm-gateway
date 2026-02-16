import type { ConversationGraph, NodeId, ChunkEvent } from "../types";
import { getNode } from "../primitives";
import { chunksOf, blocksOf } from "../queries";
import { deriveBlockContent } from "../derived";

// --- Public types ---

export interface ForceNode {
  id: string;
  kind: "chunk" | "block" | "message";
  label: string;
  color: string;
  size: number;
}

export interface ForceLink {
  source: string;
  target: string;
  type: "sequence" | "spawn";
  dashed: boolean;
}

export interface ForceHull {
  edgeId: string;
  edgeType: "block" | "message" | "summary";
  nodeIds: string[];
  color: string;
}

export interface ForceGraphData {
  nodes: ForceNode[];
  links: ForceLink[];
  hulls: ForceHull[];
}

// --- Colors ---

const CHUNK_COLORS: Record<string, string> = {
  text: "#3b82f6",
  reasoning: "#8b5cf6",
  tool_call: "#f97316",
  tool_result: "#f59e0b",
  user: "#22c55e",
  error: "#ef4444",
  harness_start: "#6b7280",
  harness_end: "#6b7280",
  relay: "#ec4899",
  usage: "#6b7280",
  tool_progress: "#f59e0b",
};

const BLOCK_COLORS: Record<string, string> = {
  text: "#3b82f680",
  tool_call: "#f9731680",
  user: "#22c55e80",
  error: "#ef444480",
  default: "#6b728080",
};

const MESSAGE_COLOR = "#ffffff20";
const SUMMARY_COLOR = "#a78bfa40";

// --- Helpers ---

function chunkColor(event: ChunkEvent): string {
  return CHUNK_COLORS[event.type] ?? "#6b7280";
}

function friendlyChunkType(type: string): string {
  switch (type) {
    case "harness_start":
      return "run start";
    case "harness_end":
      return "run end";
    case "usage":
      return "token usage";
    case "tool_result":
      return "tool result";
    case "tool_progress":
      return "progress";
    default:
      return type;
  }
}

function chunkLabel(event: ChunkEvent): string {
  switch (event.type) {
    case "text":
      return event.content.slice(0, 30);
    case "user":
      return typeof event.content === "string" ? event.content.slice(0, 30) : "[media]";
    case "tool_call":
      return event.name;
    case "tool_result":
      return `${event.name} result`;
    case "error":
      return event.message;
    case "reasoning":
      return "thinking...";
    default:
      return friendlyChunkType(event.type);
  }
}

function blockLabel(graph: ConversationGraph, blockId: NodeId): string {
  const content = deriveBlockContent(graph, blockId);
  if (!content) {
    const chunkIds = chunksOf(graph, blockId);
    if (chunkIds.length === 0) return "empty";
    const first = getNode(graph, chunkIds[0]!);
    if (!first || first.kind !== "chunk") return "empty";
    return friendlyChunkType(first.content.type);
  }
  switch (content.kind) {
    case "text":
      return content.text.slice(0, 30);
    case "tool_call":
      return content.name;
    case "user":
      return typeof content.content === "string" ? content.content.slice(0, 30) : "[media]";
    case "error":
      return content.message;
    default:
      return content.kind;
  }
}

function blockColor(graph: ConversationGraph, blockId: NodeId): string {
  const chunks = chunksOf(graph, blockId);
  if (chunks.length === 0) return BLOCK_COLORS.default!;
  const first = getNode(graph, chunks[0]!);
  if (!first || first.kind !== "chunk") return BLOCK_COLORS.default!;
  return BLOCK_COLORS[first.content.type] ?? BLOCK_COLORS.default!;
}

function messageLabel(graph: ConversationGraph, messageId: NodeId): string {
  const blocks = blocksOf(graph, messageId);
  for (const blockId of blocks) {
    const content = deriveBlockContent(graph, blockId);
    if (content?.kind === "user") {
      return typeof content.content === "string" ? content.content.slice(0, 30) : "[user]";
    }
  }
  return `assistant (${blocks.length} blocks)`;
}

// --- Main projection ---

export function projectForceGraph(graph: ConversationGraph, active: Set<NodeId>): ForceGraphData {
  const nodes: ForceNode[] = [];
  const links: ForceLink[] = [];
  const hulls: ForceHull[] = [];
  const visibleIds = new Set<string>();

  // 1. Collect visible nodes
  for (const nodeId of active) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    visibleIds.add(nodeId);

    switch (node.kind) {
      case "chunk":
        nodes.push({
          id: nodeId,
          kind: "chunk",
          label: chunkLabel(node.content),
          color: chunkColor(node.content),
          size: 4,
        });
        break;
      case "block":
        nodes.push({
          id: nodeId,
          kind: "block",
          label: blockLabel(graph, nodeId),
          color: blockColor(graph, nodeId),
          size: 8,
        });
        break;
      case "message":
        nodes.push({
          id: nodeId,
          kind: "message",
          label: messageLabel(graph, nodeId),
          color: "#e5e7eb",
          size: 14,
        });
        break;
    }
  }

  // 2. Collect visible links (sequence + spawn edges between visible nodes)
  for (const edge of graph.edges.values()) {
    if (edge.type === "sequence") {
      for (const pred of edge.roles.predecessor) {
        for (const succ of edge.roles.successor) {
          if (visibleIds.has(pred) && visibleIds.has(succ)) {
            links.push({
              source: pred,
              target: succ,
              type: "sequence",
              dashed: false,
            });
          }
        }
      }
    } else if (edge.type === "spawn") {
      for (const trigger of edge.roles.trigger) {
        for (const inv of edge.roles.invocation) {
          if (visibleIds.has(trigger) && visibleIds.has(inv)) {
            links.push({
              source: trigger,
              target: inv,
              type: "spawn",
              dashed: true,
            });
          }
        }
      }
    }
  }

  // 3. Collect hulls (containment edges where members are visible)
  for (const edge of graph.edges.values()) {
    if (edge.type === "block") {
      const visibleParts = edge.roles.part.filter((id) => visibleIds.has(id));
      if (visibleParts.length >= 2) {
        hulls.push({
          edgeId: edge.id,
          edgeType: "block",
          nodeIds: visibleParts,
          color: BLOCK_COLORS.default!,
        });
      }
    } else if (edge.type === "message") {
      const visibleParts = edge.roles.part.filter((id) => visibleIds.has(id));
      if (visibleParts.length >= 2) {
        hulls.push({
          edgeId: edge.id,
          edgeType: "message",
          nodeIds: visibleParts,
          color: MESSAGE_COLOR,
        });
      }
    } else if (edge.type === "summary") {
      const visibleSources = edge.roles.source.filter((id) => visibleIds.has(id));
      if (visibleSources.length >= 2) {
        hulls.push({
          edgeId: edge.id,
          edgeType: "summary",
          nodeIds: visibleSources,
          color: SUMMARY_COLOR,
        });
      }
    }
  }

  return { nodes, links, hulls };
}
