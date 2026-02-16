import type { ContentPart } from "../../../types";
import type { ConversationGraph, NodeId } from "../types";
import { getNode, findEdges } from "../primitives";
import { blockOf } from "../queries";
import { accumulate } from "../../progress";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ViewContent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; input: unknown; output?: unknown; progress?: unknown }
  | { kind: "user"; content: string | ContentPart[] }
  | { kind: "error"; message: string }
  | { kind: "pending" }
  | {
      kind: "relay";
      relayKind: "permission";
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

export interface ViewNode {
  id: string;
  runId: string;
  role: "user" | "assistant";
  content: ViewContent;
  status: "streaming" | "complete" | "error";
  branches: ViewNode[][];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the original event id (matching the old graph's node id scheme).
 */
function eventId(event: any): string {
  switch (event.type) {
    case "text":
    case "reasoning":
    case "tool_call":
    case "relay":
    case "tool_progress":
      return event.id;
    case "tool_result":
      return `${event.id}:result`;
    case "harness_start":
      return `${event.runId}:harness_start`;
    case "harness_end":
      return `${event.runId}:harness_end`;
    case "error":
      return `${event.runId}:error`;
    case "user":
      return `${event.runId}:user`;
    default:
      return "";
  }
}

/**
 * Convert a chunk event to ViewContent.
 * Returns null for structural events that don't produce their own ViewNode.
 */
function eventToViewContent(event: any): ViewContent | null {
  switch (event.type) {
    case "text":
      return { kind: "text", text: event.content };
    case "reasoning":
      return { kind: "reasoning", text: event.content };
    case "tool_call":
      return { kind: "tool_call", name: event.name, input: event.input, progress: null };
    case "user":
      return { kind: "user", content: event.content };
    case "error":
      return { kind: "error", message: event.message };
    case "relay":
      return {
        kind: "relay",
        relayKind: event.kind,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
    case "harness_start":
    case "harness_end":
    case "usage":
    case "tool_result":
    case "tool_progress":
      return null;
    default:
      return null;
  }
}

/**
 * Determine the role for an event.
 */
function eventRole(event: any): "user" | "assistant" {
  return event.type === "user" ? "user" : "assistant";
}

/**
 * Derive run status by checking for lifecycle block nodes.
 */
function deriveRunStatus(
  graph: ConversationGraph,
  runId: string,
): "streaming" | "complete" | "error" {
  if (graph.nodes.has(`block:${runId}:error`)) return "error";
  if (graph.nodes.has(`block:${runId}:harness_end`)) return "complete";
  if (graph.nodes.has(`block:${runId}:harness_start`)) return "streaming";
  // For user events there is no harness lifecycle -- treat as complete
  return "complete";
}

/**
 * Find the next chunk in sequence order.
 */
function findNextChunk(graph: ConversationGraph, chunkId: NodeId): NodeId | null {
  const seqEdges = findEdges(graph, { type: "sequence", node: chunkId, role: "predecessor" });
  for (const edge of seqEdges) {
    for (const successorId of edge.roles.successor) {
      const node = getNode(graph, successorId);
      if (node?.kind === "chunk") return successorId;
    }
  }
  return null;
}

/**
 * Find spawn targets (subagent first chunks) from the block containing this chunk.
 */
function findSpawnTargets(graph: ConversationGraph, chunkId: NodeId): NodeId[] {
  const blk = blockOf(graph, chunkId);
  if (!blk) return [];
  const spawnEdges = findEdges(graph, { type: "spawn", node: blk, role: "trigger" });
  const targets: NodeId[] = [];
  for (const edge of spawnEdges) {
    targets.push(...edge.roles.invocation);
  }
  return targets;
}

/**
 * Find root chunks: first chunks of root runs (not spawned by another run).
 * Returns them in insertion order.
 */
function findRootChunks(graph: ConversationGraph): NodeId[] {
  const roots: NodeId[] = [];
  for (const [id, node] of graph.nodes) {
    if (node.kind !== "chunk") continue;
    // Check if this chunk has a sequence predecessor (not first in its run)
    const predEdges = findEdges(graph, { type: "sequence", node: id, role: "successor" });
    const hasChunkPred = predEdges.some((edge) =>
      edge.roles.predecessor.some((pid) => getNode(graph, pid)?.kind === "chunk"),
    );
    if (hasChunkPred) continue;
    // Check if this chunk is the invocation target of a spawn edge
    const spawnEdges = findEdges(graph, { type: "spawn", node: id, role: "invocation" });
    if (spawnEdges.length > 0) continue;
    roots.push(id);
  }
  return roots;
}

/**
 * Walk from a start chunk following sequence edges. Produces ViewNode[] for one
 * contiguous run (sequential chain), and recursively projects branches
 * for cross-run spawn edges.
 */
function walkRun(graph: ConversationGraph, startChunkId: NodeId, visited: Set<NodeId>): ViewNode[] {
  const result: ViewNode[] = [];
  let current: NodeId | null = startChunkId;

  while (current !== null) {
    if (visited.has(current)) break;
    visited.add(current);

    const chunkNode = getNode(graph, current);
    if (!chunkNode || chunkNode.kind !== "chunk") break;

    const event = chunkNode.content as any;
    const content = eventToViewContent(event);
    const runId: string = event.runId ?? "";

    // Find same-run continuation (next chunk in sequence)
    let continuation: NodeId | null = findNextChunk(graph, current);

    // Find cross-run targets via spawn edges from this chunk's block
    const crossRunTargets = findSpawnTargets(graph, current).filter((t) => !visited.has(t));

    // Promotion logic: same as old graph projection
    const canPromote = event.type !== "tool_call";
    let branchStarts: NodeId[];
    if (continuation) {
      branchStarts = crossRunTargets;
    } else if (crossRunTargets.length > 0 && canPromote) {
      continuation = crossRunTargets[0]!;
      branchStarts = crossRunTargets.slice(1);
    } else {
      branchStarts = crossRunTargets;
    }

    // If this chunk produces content, create or merge a ViewNode
    if (content !== null) {
      const lastView = result[result.length - 1];
      const canMerge =
        lastView &&
        lastView.runId === runId &&
        lastView.content.kind === content.kind &&
        (content.kind === "text" || content.kind === "reasoning");

      if (canMerge && lastView) {
        // Merge consecutive text or reasoning chunks
        if (lastView.content.kind === "text" && content.kind === "text") {
          lastView.content = { kind: "text", text: lastView.content.text + content.text };
        } else if (lastView.content.kind === "reasoning" && content.kind === "reasoning") {
          lastView.content = { kind: "reasoning", text: lastView.content.text + content.text };
        }
      } else {
        // Create new ViewNode
        const viewNode: ViewNode = {
          id: eventId(event),
          runId,
          role: eventRole(event),
          content,
          status: deriveRunStatus(graph, runId),
          branches: [],
        };

        // Build branches from cross-run spawn targets
        for (const branchStartId of branchStarts) {
          if (!visited.has(branchStartId)) {
            const branch = walkRun(graph, branchStartId, visited);
            if (branch.length > 0) {
              viewNode.branches.push(branch);
            }
          }
        }

        result.push(viewNode);
      }
    } else {
      // Structural chunks don't produce ViewNodes but may have cross-run
      // branches that need walking.
      for (const branchStartId of branchStarts) {
        if (!visited.has(branchStartId)) {
          const branch = walkRun(graph, branchStartId, visited);
          result.push(...branch);
        }
      }

      // A harness_start with no continuation yet (subagent just spawned)
      // emits a pending placeholder so the branch isn't discarded.
      if (event.type === "harness_start" && !continuation && result.length === 0) {
        const status = deriveRunStatus(graph, runId);
        if (status === "streaming") {
          result.push({
            id: eventId(event),
            runId,
            role: "assistant",
            content: { kind: "pending" },
            status,
            branches: [],
          });
        }
      }
    }

    // If the chunk is tool_result, attach its output to the matching tool_call ViewNode
    if (event.type === "tool_result") {
      const toolCallId = event.id;
      for (let i = result.length - 1; i >= 0; i--) {
        const v = result[i]!;
        if (v.content.kind === "tool_call" && v.id === toolCallId) {
          v.content = { ...v.content, output: event.output };
          break;
        }
      }
    }

    // If the chunk is tool_progress, accumulate into the matching tool_call ViewNode
    if (event.type === "tool_progress") {
      for (let i = result.length - 1; i >= 0; i--) {
        const v = result[i]!;
        if (v.content.kind === "tool_call" && v.id === event.toolCallId) {
          const progressContents: unknown[] = [];
          for (const n of graph.nodes.values()) {
            if (
              n.kind === "chunk" &&
              (n.content as any).type === "tool_progress" &&
              (n.content as any).toolCallId === event.toolCallId
            ) {
              progressContents.push((n.content as any).content);
            }
          }
          v.content = { ...v.content, progress: accumulate(event.name, progressContents) };
          break;
        }
      }
    }

    // Follow continuation
    current = continuation;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Project a conversation hypergraph into a flat list of ViewNodes for rendering.
 *
 * Walks at chunk level (since chunks ARE the original events), following
 * chunk sequence edges as continuations and spawn edges as branches.
 * Output is identical to the old graph's projectThread.
 */
export function projectThread(graph: ConversationGraph): ViewNode[] {
  if (graph.nodes.size === 0) return [];

  const visited = new Set<NodeId>();
  const result: ViewNode[] = [];
  const roots = findRootChunks(graph);

  for (const rootId of roots) {
    if (visited.has(rootId)) continue;
    const viewNodes = walkRun(graph, rootId, visited);
    result.push(...viewNodes);
  }

  return result;
}
