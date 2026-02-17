import type { ConversationGraph, NodeId } from "../types";
import { getNode, findEdges } from "../primitives";
import { chunksOf, blocksOf, blockOf } from "../queries";
import { deriveBlockContent } from "../derived";

// --- Public types ---

export interface ForceNode {
  id: string;
  kind: "block";
  blockType: "text" | "reasoning" | "tool_call" | "tool_result" | "user" | "error" | "structural";
  label: string;
  color: string;
  borderColor: string;
  width: number;
  height: number;
}

export interface ForceLink {
  source: string;
  target: string;
  type: "sequence" | "spawn";
  dashed: boolean;
}

export interface ForceHull {
  edgeId: string;
  edgeType: "message" | "summary";
  level: "message";
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

const BLOCK_FILL_COLORS: Record<string, string> = {
  text: "#1e3a5f",
  reasoning: "#2d1f5e",
  tool_call: "#4a2a0a",
  tool_result: "#3d2a05",
  user: "#0a3d1f",
  error: "#3d0a0a",
  structural: "#1f2937",
};

const BLOCK_BORDER_COLORS: Record<string, string> = {
  text: "#3b82f6",
  reasoning: "#8b5cf6",
  tool_call: "#f97316",
  tool_result: "#f59e0b",
  user: "#22c55e",
  error: "#ef4444",
  structural: "#4b5563",
};

const MESSAGE_HULL_COLORS: Record<string, string> = {
  user: "rgba(34,197,94,0.08)",
  assistant: "rgba(59,130,246,0.08)",
};

const SUMMARY_HULL_COLOR = "rgba(167,139,250,0.12)";

// --- Helpers ---

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

/**
 * Derive the block type from the block's content or first chunk event type.
 */
function deriveBlockType(graph: ConversationGraph, blockId: NodeId): ForceNode["blockType"] {
  const content = deriveBlockContent(graph, blockId);
  if (content) {
    switch (content.kind) {
      case "text":
        return "text";
      case "reasoning":
        return "reasoning";
      case "tool_call":
        return "tool_call";
      case "user":
        return "user";
      case "error":
        return "error";
      case "relay":
        return "structural";
      default:
        return "structural";
    }
  }
  // Structural blocks: check first chunk event type
  const chunkIds = chunksOf(graph, blockId);
  if (chunkIds.length === 0) return "structural";
  const first = getNode(graph, chunkIds[0]!);
  if (!first || first.kind !== "chunk") return "structural";
  switch (first.content.type) {
    case "tool_result":
      return "tool_result";
    default:
      return "structural";
  }
}

/**
 * Derive a label for a block node.
 */
function blockLabel(graph: ConversationGraph, blockId: NodeId): string {
  const content = deriveBlockContent(graph, blockId);
  if (!content) {
    const chunkIds = chunksOf(graph, blockId);
    if (chunkIds.length === 0) return "empty";
    const first = getNode(graph, chunkIds[0]!);
    if (!first || first.kind !== "chunk") return "empty";
    if (first.content.type === "tool_result") {
      return `${first.content.name} result`;
    }
    return friendlyChunkType(first.content.type);
  }
  switch (content.kind) {
    case "text":
      return content.text;
    case "reasoning":
      return content.text || "thinking...";
    case "tool_call":
      return content.name;
    case "user":
      return typeof content.content === "string" ? content.content : "[media]";
    case "error":
      return content.message;
    default:
      return content.kind;
  }
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

// --- Main projection ---

export function projectForceGraph(graph: ConversationGraph): ForceGraphData {
  const nodes: ForceNode[] = [];
  const links: ForceLink[] = [];
  const hulls: ForceHull[] = [];
  const blockIds = new Set<string>();

  // 1. Collect all block nodes
  for (const [nodeId, node] of graph.nodes) {
    if (node.kind !== "block") continue;
    blockIds.add(nodeId);

    const blockType = deriveBlockType(graph, nodeId);
    const label = blockLabel(graph, nodeId);
    // Width: ~7px per char, min 100, max 400 for readability
    const width = Math.min(Math.max(label.length * 7, 100), 400);
    // Height: base 30, add 16 per ~50 chars of wrapped text
    const lines = Math.ceil(label.length / 50);
    const height = Math.max(30, 20 + lines * 16);

    nodes.push({
      id: nodeId,
      kind: "block",
      blockType,
      label,
      color: BLOCK_FILL_COLORS[blockType] ?? BLOCK_FILL_COLORS.structural!,
      borderColor: BLOCK_BORDER_COLORS[blockType] ?? BLOCK_BORDER_COLORS.structural!,
      width,
      height,
    });
  }

  // 2. Collect links between block nodes
  for (const edge of graph.edges.values()) {
    if (edge.type === "sequence") {
      for (const pred of edge.roles.predecessor) {
        for (const succ of edge.roles.successor) {
          // Block-to-block sequence (within same message/run)
          if (blockIds.has(pred) && blockIds.has(succ)) {
            links.push({
              source: pred,
              target: succ,
              type: "sequence",
              dashed: false,
            });
          }
          // Message-to-message sequence: resolve to last block → first block
          const predNode = graph.nodes.get(pred);
          const succNode = graph.nodes.get(succ);
          if (predNode?.kind === "message" && succNode?.kind === "message") {
            const predBlocks = blocksOf(graph, pred);
            const succBlocks = blocksOf(graph, succ);
            const lastBlock = predBlocks[predBlocks.length - 1];
            const firstBlock = succBlocks[0];
            if (lastBlock && firstBlock && blockIds.has(lastBlock) && blockIds.has(firstBlock)) {
              links.push({
                source: lastBlock,
                target: firstBlock,
                type: "sequence",
                dashed: false,
              });
            }
          }
        }
      }
    } else if (edge.type === "spawn") {
      // Spawn: trigger is a block ID, invocation is a chunk ID
      // For the trigger side, use the trigger block directly
      // For the invocation side, find which block contains that chunk
      for (const triggerId of edge.roles.trigger) {
        if (!blockIds.has(triggerId)) continue;

        for (const inv of edge.roles.invocation) {
          const invBlockId = blockOf(graph, inv);
          if (invBlockId && blockIds.has(invBlockId)) {
            links.push({
              source: triggerId,
              target: invBlockId,
              type: "spawn",
              dashed: true,
            });
          }
        }
      }
    }
  }

  // 3. Collect hulls
  // Message hulls: block IDs are directly available from message edge roles.part
  for (const edge of graph.edges.values()) {
    if (edge.type === "message") {
      const messageNodeId = edge.roles.whole[0];
      if (!messageNodeId) continue;
      const msgBlocks = edge.roles.part.filter((id) => blockIds.has(id));
      if (msgBlocks.length === 0) continue;
      hulls.push({
        edgeId: edge.id,
        edgeType: "message",
        level: "message",
        nodeIds: msgBlocks,
        color: messageHullColor(graph, messageNodeId),
        label: messageLabel(graph, messageNodeId),
        padding: 20,
      });
    }
  }

  // Summary hulls: expand source messages to their block IDs
  for (const edge of graph.edges.values()) {
    if (edge.type === "summary") {
      const sourceBlocks: NodeId[] = [];
      for (const sourceId of edge.roles.source) {
        const blocks = blocksOf(graph, sourceId);
        for (const blockId of blocks) {
          if (blockIds.has(blockId)) {
            sourceBlocks.push(blockId);
          }
        }
      }
      if (sourceBlocks.length === 0) continue;
      hulls.push({
        edgeId: edge.id,
        edgeType: "summary",
        level: "message",
        nodeIds: sourceBlocks,
        color: SUMMARY_HULL_COLOR,
        label: "summarized",
        padding: 35,
      });
    }
  }

  // Sort hulls: message first (rendered behind), summary next
  hulls.sort((a, b) => {
    const order: Record<string, number> = { message: 0, summary: 1 };
    return (order[a.edgeType] ?? 0) - (order[b.edgeType] ?? 0);
  });

  return { nodes, links, hulls };
}
