import type { ConversationGraph, NodeId } from "../types";
import { getNode } from "../primitives";
import { chunksOf, blocksOf, blockOf } from "../queries";
import { deriveBlockContent } from "../derived";

// --- Public types ---

export type BlockType =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "user"
  | "error"
  | "relay"
  | "structural";

export interface DAGNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blockType: BlockType;
  label: string;
  color: string;
  borderColor: string;
}

export interface DAGEdge {
  source: string;
  target: string;
  type: "sequence" | "spawn";
}

export interface DAGGroup {
  id: string;
  edgeType: "message" | "summary";
  label: string;
  color: string;
  borderColor: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DAGLayout {
  nodes: DAGNode[];
  edges: DAGEdge[];
  groups: DAGGroup[];
  totalWidth: number;
  totalHeight: number;
}

// --- Layout constants ---

const NODE_GAP = 12;
const COLUMN_GAP = 40;
const GROUP_PAD = 12;
const LAYOUT_PAD = GROUP_PAD + 16; // room for group padding + labels above first row

// --- Colors ---

const BLOCK_FILL_COLORS: Record<string, string> = {
  text: "#1e3a5f",
  reasoning: "#2d1f5e",
  tool_call: "#4a2a0a",
  tool_result: "#3d2a05",
  user: "#0a3d1f",
  error: "#3d0a0a",
  relay: "#3d2b08",
  structural: "#1f2937",
};

const BLOCK_BORDER_COLORS: Record<string, string> = {
  text: "#3b82f6",
  reasoning: "#8b5cf6",
  tool_call: "#f97316",
  tool_result: "#f59e0b",
  user: "#22c55e",
  error: "#ef4444",
  relay: "#f59e0b",
  structural: "#4b5563",
};

const MESSAGE_HULL_COLORS: Record<string, string> = {
  user: "rgba(34,197,94,0.08)",
  assistant: "rgba(59,130,246,0.08)",
};

const MESSAGE_BORDER_COLORS: Record<string, string> = {
  user: "rgba(34,197,94,0.3)",
  assistant: "rgba(59,130,246,0.3)",
};

const SUMMARY_HULL_COLOR = "rgba(167,139,250,0.12)";
const SUMMARY_BORDER_COLOR = "rgba(167,139,250,0.3)";

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

function deriveBlockType(graph: ConversationGraph, blockId: NodeId): BlockType {
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
        return "relay";
      default:
        return "structural";
    }
  }
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
    case "relay":
      return `${content.tool}(${Object.entries(content.params).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")})`;
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

function messageBorderColor(graph: ConversationGraph, messageId: NodeId): string {
  const blocks = blocksOf(graph, messageId);
  for (const blockId of blocks) {
    const content = deriveBlockContent(graph, blockId);
    if (content?.kind === "user") return MESSAGE_BORDER_COLORS.user!;
  }
  return MESSAGE_BORDER_COLORS.assistant!;
}

// --- Node sizing ---

function nodeWidth(label: string): number {
  return Math.min(Math.max(label.length * 7, 100), 400);
}

function nodeHeight(label: string): number {
  const lines = Math.ceil(label.length / 50);
  return Math.max(30, 20 + lines * 16);
}

// --- Main projection ---

export function projectDAG(graph: ConversationGraph): DAGLayout {
  const nodes: DAGNode[] = [];
  const edges: DAGEdge[] = [];
  const groups: DAGGroup[] = [];
  const blockIds = new Set<string>();

  // 1. Collect all block nodes with metadata (no positions yet)
  interface BlockInfo {
    id: string;
    blockType: BlockType;
    label: string;
    width: number;
    height: number;
    color: string;
    borderColor: string;
  }

  const blockInfos: BlockInfo[] = [];
  const blockInfoMap = new Map<string, BlockInfo>();

  for (const [nodeId, node] of graph.nodes) {
    if (node.kind !== "block") continue;
    blockIds.add(nodeId);

    const bt = deriveBlockType(graph, nodeId);
    const label = blockLabel(graph, nodeId);
    const info: BlockInfo = {
      id: nodeId,
      blockType: bt,
      label,
      width: nodeWidth(label),
      height: nodeHeight(label),
      color: BLOCK_FILL_COLORS[bt] ?? BLOCK_FILL_COLORS.structural!,
      borderColor: BLOCK_BORDER_COLORS[bt] ?? BLOCK_BORDER_COLORS.structural!,
    };
    blockInfos.push(info);
    blockInfoMap.set(nodeId, info);
  }

  if (blockInfos.length === 0) {
    return { nodes: [], edges: [], groups: [], totalWidth: 0, totalHeight: 0 };
  }

  // 2. Collect edges between blocks
  const seqSuccessors = new Map<string, string[]>(); // blockId → successor blockIds
  const seqPredecessors = new Map<string, string[]>(); // blockId → predecessor blockIds
  const spawnEdges: Array<{ source: string; target: string }> = [];

  for (const edge of graph.edges.values()) {
    if (edge.type === "sequence") {
      for (const pred of edge.roles.predecessor) {
        for (const succ of edge.roles.successor) {
          // Block-to-block sequence
          if (blockIds.has(pred) && blockIds.has(succ)) {
            edges.push({ source: pred, target: succ, type: "sequence" });
            if (!seqSuccessors.has(pred)) seqSuccessors.set(pred, []);
            seqSuccessors.get(pred)!.push(succ);
            if (!seqPredecessors.has(succ)) seqPredecessors.set(succ, []);
            seqPredecessors.get(succ)!.push(pred);
          }
          // Message-to-message sequence: last block → first block
          const predNode = graph.nodes.get(pred);
          const succNode = graph.nodes.get(succ);
          if (predNode?.kind === "message" && succNode?.kind === "message") {
            const predBlocks = blocksOf(graph, pred);
            const succBlocks = blocksOf(graph, succ);
            const lastBlock = predBlocks[predBlocks.length - 1];
            const firstBlock = succBlocks[0];
            if (lastBlock && firstBlock && blockIds.has(lastBlock) && blockIds.has(firstBlock)) {
              edges.push({ source: lastBlock, target: firstBlock, type: "sequence" });
              if (!seqSuccessors.has(lastBlock)) seqSuccessors.set(lastBlock, []);
              seqSuccessors.get(lastBlock)!.push(firstBlock);
              if (!seqPredecessors.has(firstBlock)) seqPredecessors.set(firstBlock, []);
              seqPredecessors.get(firstBlock)!.push(lastBlock);
            }
          }
        }
      }
    } else if (edge.type === "spawn") {
      for (const triggerId of edge.roles.trigger) {
        if (!blockIds.has(triggerId)) continue;
        for (const inv of edge.roles.invocation) {
          const invBlockId = blockOf(graph, inv);
          if (invBlockId && blockIds.has(invBlockId)) {
            spawnEdges.push({ source: triggerId, target: invBlockId });
            edges.push({ source: triggerId, target: invBlockId, type: "spawn" });
          }
        }
      }
    }
  }

  // Build spawn target set: blocks that are the first block in a spawn branch
  const spawnTargets = new Set(spawnEdges.map((e) => e.target));

  // 2b. Bridge unflushed blocks to the message chain.
  // During streaming, the current run's blocks aren't in a message yet and have
  // no cross-message edges, so the topological sort would interleave them with
  // earlier runs. Connect them to the tail of the last flushed message.
  const blocksInMessages = new Set<string>();
  for (const edge of graph.edges.values()) {
    if (edge.type === "message") {
      for (const partId of edge.roles.part) {
        if (blockIds.has(partId)) blocksInMessages.add(partId);
      }
    }
  }

  // Find unflushed root blocks: not in any message, no sequence predecessor, not a spawn target
  const unflushedRoots: string[] = [];
  for (const blockId of blockIds) {
    if (
      !blocksInMessages.has(blockId) &&
      !seqPredecessors.has(blockId) &&
      !spawnTargets.has(blockId)
    ) {
      unflushedRoots.push(blockId);
    }
  }

  if (unflushedRoots.length > 0) {
    // Find the last message (no message-level successor)
    const messageNodeIds = new Set<string>();
    const messageHasSuccessor = new Set<string>();
    for (const [nodeId, node] of graph.nodes) {
      if (node.kind === "message") messageNodeIds.add(nodeId);
    }
    for (const edge of graph.edges.values()) {
      if (edge.type === "sequence") {
        for (const pred of edge.roles.predecessor) {
          if (!messageNodeIds.has(pred)) continue;
          for (const succ of edge.roles.successor) {
            if (messageNodeIds.has(succ)) messageHasSuccessor.add(pred);
          }
        }
      }
    }

    let lastMessageId: string | null = null;
    for (const mid of messageNodeIds) {
      if (!messageHasSuccessor.has(mid)) lastMessageId = mid;
    }

    if (lastMessageId) {
      const lastMsgBlocks = blocksOf(graph, lastMessageId);
      const tailBlock = lastMsgBlocks[lastMsgBlocks.length - 1];
      if (tailBlock && blockIds.has(tailBlock)) {
        for (const rootId of unflushedRoots) {
          edges.push({ source: tailBlock, target: rootId, type: "sequence" });
          if (!seqSuccessors.has(tailBlock)) seqSuccessors.set(tailBlock, []);
          seqSuccessors.get(tailBlock)!.push(rootId);
          if (!seqPredecessors.has(rootId)) seqPredecessors.set(rootId, []);
          seqPredecessors.get(rootId)!.push(tailBlock);
        }
      }
    }
  }

  // 3. Build run membership: which blocks belong to which spawn branch
  // Find which runId each block belongs to by checking its chunks
  const blockRunId = new Map<string, string>();
  for (const blockId of blockIds) {
    const chunkIds = chunksOf(graph, blockId);
    if (chunkIds.length > 0) {
      const firstChunk = getNode(graph, chunkIds[0]!);
      if (firstChunk?.kind === "chunk" && "runId" in firstChunk.content) {
        blockRunId.set(blockId, firstChunk.content.runId);
      }
    }
  }

  // Build runId → column depth from spawn edges
  // A spawn target's run gets parentColumn + 1
  const runColumn = new Map<string, number>();
  const spawnTargetRunIds = new Map<string, string>(); // targetBlockId → its runId

  for (const blockId of spawnTargets) {
    const runId = blockRunId.get(blockId);
    if (runId) spawnTargetRunIds.set(blockId, runId);
  }

  // For each spawn edge, compute the child run's column.
  // Only tool_call triggers create a new column (real subagent spawns).
  // User→assistant spawns stay on the main spine.
  // Parallel subagents each get their own column via nextSpawnColumn.
  const nextSpawnColumn = new Map<string, number>(); // parentRunId → next available column
  for (const se of spawnEdges) {
    const parentRunId = blockRunId.get(se.source);
    const childRunId = blockRunId.get(se.target);
    if (!parentRunId || !childRunId) continue;
    if (!runColumn.has(parentRunId)) runColumn.set(parentRunId, 0);

    const triggerInfo = blockInfoMap.get(se.source);
    if (triggerInfo?.blockType === "tool_call") {
      const parentCol = runColumn.get(parentRunId)!;
      const nextCol = nextSpawnColumn.get(parentRunId) ?? (parentCol + 1);
      runColumn.set(childRunId, nextCol);
      nextSpawnColumn.set(parentRunId, nextCol + 1);
    } else {
      // Non-tool_call spawns (e.g. provider calls, user→assistant): same column as parent
      if (!runColumn.has(childRunId)) {
        runColumn.set(childRunId, runColumn.get(parentRunId)!);
      }
    }
  }

  // Assign column to each block based on its run
  function getColumn(blockId: string): number {
    const runId = blockRunId.get(blockId);
    if (!runId) return 0;
    return runColumn.get(runId) ?? 0;
  }

  // 4. Topological sort of blocks
  const inDegree = new Map<string, number>();
  for (const blockId of blockIds) inDegree.set(blockId, 0);

  // Count in-degrees from sequence edges and spawn edges
  for (const e of edges) {
    if (blockIds.has(e.target)) {
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [blockId, deg] of inDegree) {
    if (deg === 0) queue.push(blockId);
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    topoOrder.push(current);

    // Sequence successors
    for (const succ of seqSuccessors.get(current) ?? []) {
      const newDeg = (inDegree.get(succ) ?? 1) - 1;
      inDegree.set(succ, newDeg);
      if (newDeg === 0) queue.push(succ);
    }
    // Spawn successors
    for (const se of spawnEdges) {
      if (se.source === current) {
        const newDeg = (inDegree.get(se.target) ?? 1) - 1;
        inDegree.set(se.target, newDeg);
        if (newDeg === 0) queue.push(se.target);
      }
    }
  }

  // Add any blocks not reached by topological sort (disconnected/cycles)
  for (const blockId of blockIds) {
    if (!topoOrder.includes(blockId)) {
      topoOrder.push(blockId);
    }
  }

  // 5. Assign positions
  // Track the current y cursor per column
  const columnY = new Map<number, number>();
  // Track max width per column for x offset computation
  const COLUMN_WIDTH = 400; // matches max nodeWidth
  // Extra gap between blocks in different messages to prevent group overlap
  const MESSAGE_GAP = 2 * GROUP_PAD + 16; // group padding on both sides + label height

  // Build block → message map for boundary detection
  const blockToMessage = new Map<string, string>();
  for (const edge of graph.edges.values()) {
    if (edge.type === "message") {
      const msgId = edge.roles.whole[0];
      if (msgId) {
        for (const blockId of edge.roles.part) {
          blockToMessage.set(blockId, msgId);
        }
      }
    }
  }
  const lastMessageByColumn = new Map<number, string | null>();

  const positionedNodes = new Map<string, DAGNode>();

  for (const blockId of topoOrder) {
    const info = blockInfoMap.get(blockId);
    if (!info) continue;

    const col = getColumn(blockId);
    const x = LAYOUT_PAD + col * (COLUMN_WIDTH + COLUMN_GAP);
    const currentY = columnY.get(col) ?? LAYOUT_PAD;

    // Add extra spacing at message boundaries to prevent group overlap
    let y = currentY;
    const prevMsg = lastMessageByColumn.get(col) ?? null;
    const curMsg = blockToMessage.get(blockId) ?? null;
    if (prevMsg !== null && curMsg !== null && curMsg !== prevMsg) {
      y += MESSAGE_GAP;
    }
    if (spawnTargets.has(blockId)) {
      for (const se of spawnEdges) {
        if (se.target === blockId) {
          const sourceNode = positionedNodes.get(se.source);
          if (sourceNode) {
            y = Math.max(y, sourceNode.y + sourceNode.height + NODE_GAP);
          }
        }
      }
    }

    const dagNode: DAGNode = {
      id: info.id,
      x,
      y,
      width: info.width,
      height: info.height,
      blockType: info.blockType,
      label: info.label,
      color: info.color,
      borderColor: info.borderColor,
    };

    positionedNodes.set(blockId, dagNode);
    nodes.push(dagNode);
    columnY.set(col, y + info.height + NODE_GAP);
    if (curMsg !== null) lastMessageByColumn.set(col, curMsg);

    // After placing a spawn branch, push all ancestor columns' cursors
    // past the child so the parent flow continues below the spawn branch
    if (col > 0) {
      const childBottom = y + info.height + NODE_GAP;
      for (let c = col - 1; c >= 0; c--) {
        const curY = columnY.get(c) ?? 0;
        if (childBottom > curY) {
          columnY.set(c, childBottom);
        } else {
          break; // ancestor is already past this point
        }
      }
    }
  }

  // 6. Compute totalWidth and totalHeight (updated after groups are built)
  let totalWidth = 0;
  let totalHeight = 0;
  for (const node of nodes) {
    totalWidth = Math.max(totalWidth, node.x + node.width + LAYOUT_PAD);
    totalHeight = Math.max(totalHeight, node.y + node.height + LAYOUT_PAD);
  }

  // 7. Message groups
  for (const edge of graph.edges.values()) {
    if (edge.type === "message") {
      const messageNodeId = edge.roles.whole[0];
      if (!messageNodeId) continue;
      const msgBlocks = edge.roles.part.filter((id) => blockIds.has(id));
      if (msgBlocks.length === 0) continue;

      // Compute bounding box from positioned nodes
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const bid of msgBlocks) {
        const node = positionedNodes.get(bid);
        if (!node) continue;
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + node.height);
      }

      if (minX === Infinity) continue;

      groups.push({
        id: edge.id,
        edgeType: "message",
        label: messageLabel(graph, messageNodeId),
        color: messageHullColor(graph, messageNodeId),
        borderColor: messageBorderColor(graph, messageNodeId),
        x: minX - GROUP_PAD,
        y: minY - GROUP_PAD,
        width: maxX - minX + GROUP_PAD * 2,
        height: maxY - minY + GROUP_PAD * 2,
      });
    }
  }

  // 8. Summary groups
  for (const edge of graph.edges.values()) {
    if (edge.type === "summary") {
      const sourceBlocks: NodeId[] = [];
      for (const sourceId of edge.roles.source) {
        const blocks = blocksOf(graph, sourceId);
        for (const bid of blocks) {
          if (blockIds.has(bid)) sourceBlocks.push(bid);
        }
      }
      if (sourceBlocks.length === 0) continue;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const bid of sourceBlocks) {
        const node = positionedNodes.get(bid);
        if (!node) continue;
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + node.height);
      }

      if (minX === Infinity) continue;

      groups.push({
        id: edge.id,
        edgeType: "summary",
        label: "summarized",
        color: SUMMARY_HULL_COLOR,
        borderColor: SUMMARY_BORDER_COLOR,
        x: minX - GROUP_PAD,
        y: minY - GROUP_PAD,
        width: maxX - minX + GROUP_PAD * 2,
        height: maxY - minY + GROUP_PAD * 2,
      });
    }
  }

  // Sort groups: message first, summary next
  groups.sort((a, b) => {
    const order: Record<string, number> = { message: 0, summary: 1 };
    return (order[a.edgeType] ?? 0) - (order[b.edgeType] ?? 0);
  });

  return { nodes, edges, groups, totalWidth, totalHeight };
}
