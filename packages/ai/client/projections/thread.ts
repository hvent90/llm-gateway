import type { Graph, Node } from "../types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ViewContent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; input: unknown; output?: unknown }
  | { kind: "user"; text: string }
  | { kind: "error"; message: string }
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
 * Build a set of all node ids that are targets of at least one edge.
 */
function incomingSet(graph: Graph): Set<string> {
  const set = new Set<string>();
  for (const targets of graph.edges.values()) {
    for (const t of targets) set.add(t);
  }
  return set;
}

/**
 * Find root nodes (no incoming edges), preserving Map insertion order.
 */
function findRoots(graph: Graph): string[] {
  const incoming = incomingSet(graph);
  const roots: string[] = [];
  for (const id of graph.nodes.keys()) {
    if (!incoming.has(id)) roots.push(id);
  }
  return roots;
}

/**
 * Derive the status for a given runId by inspecting what lifecycle
 * nodes exist in the graph.
 */
function deriveRunStatus(graph: Graph, runId: string): "streaming" | "complete" | "error" {
  if (graph.nodes.has(`${runId}:error`)) return "error";
  if (graph.nodes.has(`${runId}:harness_end`)) return "complete";
  if (graph.nodes.has(`${runId}:harness_start`)) return "streaming";
  // For user events there is no harness lifecycle -- treat as complete
  return "complete";
}

/**
 * Convert a graph Node to ViewContent.
 * Returns null for structural nodes (harness_start, harness_end, usage, tool_result)
 * that don't produce their own ViewNode.
 */
function nodeToViewContent(node: Node): ViewContent | null {
  switch (node.kind) {
    case "text":
      return { kind: "text", text: node.content };
    case "reasoning":
      return { kind: "reasoning", text: node.content };
    case "tool_call":
      return { kind: "tool_call", name: node.name, input: node.input };
    case "user":
      return { kind: "user", text: node.content };
    case "error":
      return { kind: "error", message: node.message };
    case "relay":
      return {
        kind: "relay",
        relayKind: node.relayKind,
        toolCallId: node.toolCallId,
        tool: node.tool,
        params: node.params,
      };
    // Structural nodes that don't produce their own ViewNode
    case "harness_start":
    case "harness_end":
    case "usage":
    case "tool_result":
      return null;
    default:
      return null;
  }
}

/**
 * Determine the role for a node based on its kind.
 */
function nodeRole(node: Node): "user" | "assistant" {
  return node.kind === "user" ? "user" : "assistant";
}

/**
 * Walk from a start node following edges. Produces ViewNode[] for one
 * contiguous run (sequential chain), and recursively projects branches
 * for cross-run child edges.
 *
 * The walk follows edges from `startId` forward, collecting content nodes
 * into ViewNodes. When it encounters a tool_call with cross-run children
 * (subagent harness_start), it recurses to build branches. When it encounters
 * a tool_result, it attaches the output back to the previous tool_call
 * ViewNode rather than creating a new ViewNode.
 */
function walkRun(graph: Graph, startId: string, visited: Set<string>): ViewNode[] {
  const result: ViewNode[] = [];
  let current: string | null = startId;

  while (current !== null) {
    if (visited.has(current)) break;
    visited.add(current);

    const node = graph.nodes.get(current);
    if (!node) break;

    const content = nodeToViewContent(node);
    const edges = graph.edges.get(current) ?? [];

    // Separate edges into same-run (continuation) and cross-run targets.
    let continuation: string | null = null;
    const crossRunTargets: string[] = [];

    for (const targetId of edges) {
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) continue;
      if (targetNode.runId === node.runId) {
        if (!continuation) continuation = targetId;
      } else {
        crossRunTargets.push(targetId);
      }
    }

    // When there is a same-run continuation, all cross-run edges are branches.
    // When there is NO same-run continuation, the first cross-run edge is
    // promoted to continuation (e.g. user → assistant reply), rest are branches.
    let branchStarts: string[];
    if (continuation) {
      branchStarts = crossRunTargets;
    } else if (crossRunTargets.length > 0) {
      continuation = crossRunTargets[0]!;
      branchStarts = crossRunTargets.slice(1);
    } else {
      branchStarts = [];
    }

    // If this node produces content, create or merge a ViewNode
    if (content !== null) {
      const lastView = result[result.length - 1];
      const canMerge =
        lastView &&
        lastView.runId === node.runId &&
        lastView.content.kind === content.kind &&
        (content.kind === "text" || content.kind === "reasoning");

      if (canMerge && lastView) {
        // Merge consecutive text or reasoning nodes
        if (lastView.content.kind === "text" && content.kind === "text") {
          lastView.content = { kind: "text", text: lastView.content.text + content.text };
        } else if (lastView.content.kind === "reasoning" && content.kind === "reasoning") {
          lastView.content = { kind: "reasoning", text: lastView.content.text + content.text };
        }
      } else {
        // Create new ViewNode
        const viewNode: ViewNode = {
          id: node.id,
          runId: node.runId,
          role: nodeRole(node),
          content,
          status: deriveRunStatus(graph, node.runId),
          branches: [],
        };

        // Build branches from cross-run children
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
      // Structural nodes (harness_start, harness_end, etc.) don't produce
      // ViewNodes but may still have cross-run branches that need walking.
      for (const branchStartId of branchStarts) {
        if (!visited.has(branchStartId)) {
          const branch = walkRun(graph, branchStartId, visited);
          result.push(...branch);
        }
      }
    }

    // If the node is tool_result, attach its output to the last tool_call ViewNode
    if (node.kind === "tool_result") {
      const toolCallId = node.id.replace(/:result$/, "");
      for (let i = result.length - 1; i >= 0; i--) {
        const v = result[i]!;
        if (v.content.kind === "tool_call" && v.id === toolCallId) {
          v.content = { ...v.content, output: node.output };
          break;
        }
      }
    }

    // Follow continuation edge
    current = continuation;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Project a conversation Graph into a flat list of ViewNodes for rendering.
 *
 * Roots (nodes with no incoming edges) are found in insertion order.
 * Each root starts a walk that follows same-run edges as continuations
 * and cross-run edges as branches (nested within tool_call ViewNodes).
 */
export function projectThread(graph: Graph): ViewNode[] {
  if (graph.nodes.size === 0) return [];

  const visited = new Set<string>();
  const result: ViewNode[] = [];
  const roots = findRoots(graph);

  for (const rootId of roots) {
    if (visited.has(rootId)) continue;
    const viewNodes = walkRun(graph, rootId, visited);
    result.push(...viewNodes);
  }

  return result;
}
