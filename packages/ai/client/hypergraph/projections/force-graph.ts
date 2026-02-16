import type { ConversationGraph, NodeId, ChunkEvent } from "../types";
import { getNode } from "../primitives";
import { chunksOf, blocksOf } from "../queries";
import { deriveBlockContent } from "../derived";

// --- Public types ---

export interface ForceNode {
  id: string;
  kind: "chunk";
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
  level: "block" | "message";
  nodeIds: string[];
  color: string;
  label: string;
  padding: number;
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

const BLOCK_HULL_COLORS: Record<string, string> = {
  text: "rgba(59,130,246,0.18)",
  tool_call: "rgba(249,115,22,0.18)",
  user: "rgba(34,197,94,0.18)",
  error: "rgba(239,68,68,0.18)",
  default: "rgba(107,114,128,0.18)",
};

const MESSAGE_HULL_COLORS: Record<string, string> = {
  user: "rgba(34,197,94,0.08)",
  assistant: "rgba(59,130,246,0.08)",
};

const SUMMARY_HULL_COLOR = "rgba(167,139,250,0.12)";

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

function blockHullColor(graph: ConversationGraph, blockId: NodeId): string {
  const chunks = chunksOf(graph, blockId);
  if (chunks.length === 0) return BLOCK_HULL_COLORS.default!;
  const first = getNode(graph, chunks[0]!);
  if (!first || first.kind !== "chunk") return BLOCK_HULL_COLORS.default!;
  return BLOCK_HULL_COLORS[first.content.type] ?? BLOCK_HULL_COLORS.default!;
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

function messageHullColor(graph: ConversationGraph, messageId: NodeId): string {
  const blocks = blocksOf(graph, messageId);
  for (const blockId of blocks) {
    const content = deriveBlockContent(graph, blockId);
    if (content?.kind === "user") return MESSAGE_HULL_COLORS.user!;
  }
  return MESSAGE_HULL_COLORS.assistant!;
}

/** Flatten a block ID into its chunk IDs. */
function flattenBlockToChunks(graph: ConversationGraph, blockId: NodeId): NodeId[] {
  return chunksOf(graph, blockId);
}

/** Flatten a message ID into its chunk IDs (message -> blocks -> chunks). */
function flattenMessageToChunks(graph: ConversationGraph, messageId: NodeId): NodeId[] {
  const blockIds = blocksOf(graph, messageId);
  const result: NodeId[] = [];
  for (const blockId of blockIds) {
    result.push(...flattenBlockToChunks(graph, blockId));
  }
  return result;
}

// --- Main projection ---

export function projectForceGraph(graph: ConversationGraph): ForceGraphData {
  const nodes: ForceNode[] = [];
  const links: ForceLink[] = [];
  const hulls: ForceHull[] = [];
  const chunkIds = new Set<string>();

  // 1. Collect all chunk nodes
  for (const [nodeId, node] of graph.nodes) {
    if (node.kind !== "chunk") continue;
    chunkIds.add(nodeId);
    nodes.push({
      id: nodeId,
      kind: "chunk",
      label: chunkLabel(node.content),
      color: chunkColor(node.content),
      size: 4,
    });
  }

  // 2. Collect links between chunk nodes
  for (const edge of graph.edges.values()) {
    if (edge.type === "sequence") {
      // Only emit chunk-to-chunk sequence links
      for (const pred of edge.roles.predecessor) {
        for (const succ of edge.roles.successor) {
          if (chunkIds.has(pred) && chunkIds.has(succ)) {
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
      // Spawn: trigger is a block ID, invocation is a chunk ID
      // Resolve trigger block to its last chunk
      for (const triggerId of edge.roles.trigger) {
        const triggerChunks = chunksOf(graph, triggerId);
        const lastChunk = triggerChunks.length > 0 ? triggerChunks[triggerChunks.length - 1]! : null;
        if (!lastChunk || !chunkIds.has(lastChunk)) continue;

        for (const inv of edge.roles.invocation) {
          if (chunkIds.has(inv)) {
            links.push({
              source: lastChunk,
              target: inv,
              type: "spawn",
              dashed: true,
            });
          }
        }
      }
    }
  }

  // 3. Collect hulls
  // Block hulls
  for (const edge of graph.edges.values()) {
    if (edge.type === "block") {
      const blockNodeId = edge.roles.whole[0];
      if (!blockNodeId) continue;
      const partChunks = edge.roles.part.filter((id) => chunkIds.has(id));
      if (partChunks.length === 0) continue;
      hulls.push({
        edgeId: edge.id,
        edgeType: "block",
        level: "block",
        nodeIds: partChunks,
        color: blockHullColor(graph, blockNodeId),
        label: blockLabel(graph, blockNodeId),
        padding: 12,
      });
    }
  }

  // Message hulls
  for (const edge of graph.edges.values()) {
    if (edge.type === "message") {
      const messageNodeId = edge.roles.whole[0];
      if (!messageNodeId) continue;
      // Flatten message -> blocks -> chunks
      const msgChunks = flattenMessageToChunks(graph, messageNodeId).filter((id) => chunkIds.has(id));
      if (msgChunks.length === 0) continue;
      hulls.push({
        edgeId: edge.id,
        edgeType: "message",
        level: "message",
        nodeIds: msgChunks,
        color: messageHullColor(graph, messageNodeId),
        label: messageLabel(graph, messageNodeId),
        padding: 30,
      });
    }
  }

  // Summary hulls
  for (const edge of graph.edges.values()) {
    if (edge.type === "summary") {
      // Flatten source messages -> blocks -> chunks
      const sourceChunks: NodeId[] = [];
      for (const sourceId of edge.roles.source) {
        sourceChunks.push(...flattenMessageToChunks(graph, sourceId).filter((id) => chunkIds.has(id)));
      }
      if (sourceChunks.length === 0) continue;
      hulls.push({
        edgeId: edge.id,
        edgeType: "summary",
        level: "message",
        nodeIds: sourceChunks,
        color: SUMMARY_HULL_COLOR,
        label: "summarized",
        padding: 35,
      });
    }
  }

  // Sort hulls: message/summary first (rendered behind), then block (rendered on top)
  hulls.sort((a, b) => {
    const order = { message: 0, block: 1 };
    return (order[a.level] ?? 0) - (order[b.level] ?? 0);
  });

  return { nodes, links, hulls };
}
