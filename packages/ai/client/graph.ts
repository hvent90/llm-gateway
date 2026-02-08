import type { ContentPart } from "../types";
import type { ServerEvent } from "./server-event";
import type { Node, Graph } from "./types";

/**
 * User-initiated event (e.g., a chat message).
 */
export interface UserEvent {
  type: "user";
  runId: string;
  parentId?: string;
  content: string | ContentPart[];
}

/**
 * All events the graph reducer can process.
 */
export type GraphEvent = ServerEvent | UserEvent;

/**
 * Create an empty conversation graph.
 */
export function createGraph(): Graph {
  return {
    nodes: new Map(),
    edges: new Map(),
    lastNodeByRunId: new Map(),
  };
}

// Internal counter for usage events (which have no stable id).
let usageCounter = 0;

/**
 * Derive a deterministic node id from an event.
 * Returns null for events that should be skipped (e.g., "connected").
 */
function deriveNodeId(event: GraphEvent): string | null {
  switch (event.type) {
    case "connected":
      return null;

    // Events with their own `id` field
    case "text":
    case "reasoning":
    case "tool_call":
    case "relay":
      return event.id;

    // tool_result shares the tool_call's id, so we suffix with `:result`
    case "tool_result":
      return `${event.id}:result`;

    case "tool_progress":
      return event.id;

    // Lifecycle events keyed by runId
    case "harness_start":
      return `${event.runId}:harness_start`;
    case "harness_end":
      return `${event.runId}:harness_end`;
    case "error":
      return `${event.runId}:error`;

    // Usage events have no id -- use a counter
    case "usage":
      return `${event.runId}:usage:${++usageCounter}`;

    // User events
    case "user":
      return `${event.runId}:user`;

    default:
      return null;
  }
}

/**
 * Map an event + derived id into a Node.
 */
function eventToNode(id: string, event: GraphEvent): Node {
  const runId = event.type === "connected" ? "" : event.runId;

  switch (event.type) {
    case "text":
      return { id, runId, kind: "text", content: event.content };
    case "reasoning":
      return { id, runId, kind: "reasoning", content: event.content };
    case "tool_call":
      return { id, runId, kind: "tool_call", name: event.name, input: event.input };
    case "tool_result":
      return { id, runId, kind: "tool_result", name: event.name, output: event.output };
    case "tool_progress":
      return { id, runId, kind: "tool_progress", toolCallId: event.toolCallId, name: event.name, content: event.content };
    case "harness_start":
      return { id, runId, kind: "harness_start", agentId: event.agentId };
    case "harness_end":
      return { id, runId, kind: "harness_end", agentId: event.agentId };
    case "error":
      return { id, runId, kind: "error", message: event.message };
    case "usage":
      return {
        id,
        runId,
        kind: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case "relay":
      return {
        id,
        runId,
        kind: "relay",
        relayKind: event.kind,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
    case "user":
      return { id, runId, kind: "user", content: event.content };
    default:
      throw new Error(`Unknown event type: ${(event as any).type}`);
  }
}

/**
 * Add an edge from `source` to `target` in the edges map (cloned).
 */
function addEdge(
  edges: Map<string, string[]>,
  source: string,
  target: string,
): Map<string, string[]> {
  const existing = edges.get(source);
  if (existing) {
    edges.set(source, [...existing, target]);
  } else {
    edges.set(source, [target]);
  }
  return edges;
}

/**
 * Pure reducer: apply a GraphEvent to produce a new Graph.
 */
export function reduceEvent(graph: Graph, event: GraphEvent): Graph {
  const nodeId = deriveNodeId(event);
  if (nodeId === null) return graph;

  // Clone all maps for immutability
  const nodes = new Map(graph.nodes);
  let edges = new Map(graph.edges);
  // Deep clone edge arrays so we don't mutate originals
  for (const [k, v] of edges) {
    edges.set(k, [...v]);
  }
  const lastNodeByRunId = new Map(graph.lastNodeByRunId);

  // --- Streaming append for text/reasoning ---
  const existingNode = nodes.get(nodeId);
  if (existingNode) {
    if (
      (event.type === "text" && existingNode.kind === "text") ||
      (event.type === "reasoning" && existingNode.kind === "reasoning")
    ) {
      // Append content, don't add new edges
      nodes.set(nodeId, { ...existingNode, content: existingNode.content + event.content } as Node);
      return { nodes, edges, lastNodeByRunId };
    }
  }

  // --- Create the new node ---
  const node = eventToNode(nodeId, event);
  nodes.set(nodeId, node);

  // --- Edges ---
  const runId = event.type === "connected" ? "" : event.runId;
  const parentId = "parentId" in event ? event.parentId : undefined;
  const prevInRun = lastNodeByRunId.get(runId);

  // Cross-run edge: if this is the first event in this run AND has parentId
  if (!prevInRun && parentId) {
    edges = addEdge(edges, parentId, nodeId);
  }

  // Sequential edge: from the previous node in this run to this node
  if (prevInRun) {
    edges = addEdge(edges, prevInRun, nodeId);
  }

  // Update last node tracking
  lastNodeByRunId.set(runId, nodeId);

  return { nodes, edges, lastNodeByRunId };
}
