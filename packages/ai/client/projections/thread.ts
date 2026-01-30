import type { Graph, Node } from "../types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ViewNode {
  id: string;
  runId: string;
  role: "user" | "assistant";
  content: ViewContent;
  status: "streaming" | "complete" | "error";
  branches: ViewNode[][];
}

export type ViewContent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown; output?: unknown }
  | { kind: "user"; text: string };

// ---------------------------------------------------------------------------
// Structural node kinds that are never rendered.
// ---------------------------------------------------------------------------

const SKIP_KINDS = new Set<Node["kind"]>([
  "harness_start",
  "harness_end",
  "usage",
  "error",
  "relay",
  "tool_result",
]);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function projectThread(graph: Graph): ViewNode[] {
  if (graph.nodes.size === 0) return [];

  const roots = findRoots(graph);
  if (roots.length === 0) return [];

  // Determine the "main" runId — the runId of the first root node.
  // All root nodes are entry points; we walk from each root in order.
  const completedRuns = getCompletedRuns(graph);

  const result: ViewNode[] = [];
  for (const rootId of roots) {
    const walked = walkThread(graph, rootId, completedRuns);
    mergeInto(result, walked);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Find root nodes (nodes with no incoming edge)
// ---------------------------------------------------------------------------

function findRoots(graph: Graph): string[] {
  const hasIncoming = new Set<string>();
  for (const targets of graph.edges.values()) {
    for (const t of targets) hasIncoming.add(t);
  }

  const roots: string[] = [];
  for (const id of graph.nodes.keys()) {
    if (!hasIncoming.has(id)) roots.push(id);
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Determine which runs have completed (have a harness_end node)
// ---------------------------------------------------------------------------

function getCompletedRuns(graph: Graph): Set<string> {
  const completed = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind === "harness_end") completed.add(node.runId);
  }
  return completed;
}

// ---------------------------------------------------------------------------
// Walk a thread starting from a node, producing ViewNode[]
// ---------------------------------------------------------------------------

function walkThread(graph: Graph, startId: string, completedRuns: Set<string>): ViewNode[] {
  const result: ViewNode[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  const startNode = graph.nodes.get(startId);
  const threadRunId = startNode?.runId;

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const node = graph.nodes.get(currentId);
    if (!node) break;

    const targets: string[] = graph.edges.get(currentId) ?? [];

    // Separate continuation (same run) from cross-run targets.
    let continuation: string | null = null;
    const crossRunTargets: string[] = [];

    for (const tid of targets) {
      const targetNode = graph.nodes.get(tid);
      if (!targetNode) continue;
      if (targetNode.runId === node.runId) {
        if (!continuation) continuation = tid;
      } else {
        crossRunTargets.push(tid);
      }
    }

    // When there is a same-run continuation, cross-run edges are branches.
    // When there is NO same-run continuation, the first cross-run edge is
    // promoted to the continuation (e.g. user → assistant reply), and the
    // rest remain branches.
    let branchStarts: string[];
    if (continuation) {
      branchStarts = crossRunTargets;
    } else if (crossRunTargets.length > 0) {
      continuation = crossRunTargets[0]!;
      branchStarts = crossRunTargets.slice(1);
    } else {
      branchStarts = [];
    }

    // Skip structural nodes but still follow edges.
    if (SKIP_KINDS.has(node.kind)) {
      currentId = continuation;
      continue;
    }

    // Convert node to ViewContent.
    const content = nodeToContent(node, graph);
    if (!content) {
      currentId = continuation;
      continue;
    }

    const status = getNodeStatus(node, completedRuns);
    const role: "user" | "assistant" = node.kind === "user" ? "user" : "assistant";

    // Recursively walk branches.
    const branches: ViewNode[][] = [];
    for (const branchStart of branchStarts) {
      const branch = walkThread(graph, branchStart, completedRuns);
      if (branch.length > 0) branches.push(branch);
    }

    const viewNode: ViewNode = {
      id: node.id,
      runId: node.runId,
      role,
      content,
      status,
      branches,
    };

    result.push(viewNode);

    currentId = continuation;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Convert a Node to ViewContent
// ---------------------------------------------------------------------------

function nodeToContent(node: Node, graph: Graph): ViewContent | null {
  switch (node.kind) {
    case "text":
      return { kind: "text", text: node.content };
    case "reasoning":
      return { kind: "reasoning", text: node.content };
    case "tool_call": {
      // Look up tool_result via the `${eventId}:result` node id.
      const resultNode = graph.nodes.get(`${node.eventId}:result`);
      const output =
        resultNode && resultNode.kind === "tool_result" ? resultNode.output : undefined;
      return { kind: "tool_call", id: node.eventId, name: node.name, input: node.input, output };
    }
    case "user":
      return { kind: "user", text: node.content };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Determine streaming / complete / error status for a node
// ---------------------------------------------------------------------------

function getNodeStatus(node: Node, completedRuns: Set<string>): "streaming" | "complete" | "error" {
  if (node.kind === "error") return "error";
  return completedRuns.has(node.runId) ? "complete" : "streaming";
}

// ---------------------------------------------------------------------------
// Merge consecutive same-kind text/reasoning ViewNodes
// ---------------------------------------------------------------------------

function mergeInto(target: ViewNode[], source: ViewNode[]): void {
  for (const node of source) {
    const last = target[target.length - 1];
    if (last && tryMerge(last, node)) continue;
    target.push(node);
  }
}

function tryMerge(a: ViewNode, b: ViewNode): boolean {
  if (a.runId !== b.runId) return false;

  if (a.content.kind === "text" && b.content.kind === "text") {
    a.content = { kind: "text", text: a.content.text + b.content.text };
    // Keep later status if it's more "final"
    a.status = b.status;
    return true;
  }

  if (a.content.kind === "reasoning" && b.content.kind === "reasoning") {
    a.content = { kind: "reasoning", text: a.content.text + b.content.text };
    a.status = b.status;
    return true;
  }

  return false;
}
