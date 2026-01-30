import type { ServerEvent } from "./server-event";
import type { Node, Graph, GraphBuilderState } from "./types";

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string;
};

export type GraphEvent = ServerEvent | UserEvent;

export function createInitialGraph(): GraphBuilderState {
  return {
    nodes: new Map(),
    edges: new Map(),
    nextId: 0,
    lastNodeByRun: new Map(),
  };
}

export function reduceGraphEvent(state: GraphBuilderState, event: GraphEvent): GraphBuilderState {
  if (event.type === "connected") return state;

  const node = eventToNode(state, event);
  if (!node) return state;

  const newNodes = new Map(state.nodes);
  newNodes.set(node.id, node);

  const newEdges = new Map(state.edges);
  const newLastByRun = new Map(state.lastNodeByRun);

  const runId = node.runId;

  // Sequential edge: previous node in same run → this node
  const prevInRun = state.lastNodeByRun.get(runId);
  if (prevInRun) {
    const existing = newEdges.get(prevInRun) ?? [];
    newEdges.set(prevInRun, [...existing, node.id]);
  }

  // Cross-run edge: parentId → this node
  const parentId = "parentId" in event ? (event as any).parentId : undefined;
  if (parentId && parentId !== prevInRun) {
    if (state.nodes.has(parentId)) {
      const existing = newEdges.get(parentId) ?? [];
      if (!existing.includes(node.id)) {
        newEdges.set(parentId, [...existing, node.id]);
      }
    } else {
      const parentLastNode = state.lastNodeByRun.get(parentId);
      if (parentLastNode && parentLastNode !== prevInRun) {
        const existing = newEdges.get(parentLastNode) ?? [];
        if (!existing.includes(node.id)) {
          newEdges.set(parentLastNode, [...existing, node.id]);
        }
      }
    }
  }

  newLastByRun.set(runId, node.id);

  return {
    nodes: newNodes,
    edges: newEdges,
    nextId: state.nextId + 1,
    lastNodeByRun: newLastByRun,
  };
}

function eventToNode(state: GraphBuilderState, event: GraphEvent): Node | null {
  switch (event.type) {
    case "text":
      return { id: event.id, runId: event.runId, kind: "text", content: event.content };
    case "reasoning":
      return { id: event.id, runId: event.runId, kind: "reasoning", content: event.content };
    case "tool_call":
      return {
        id: event.id,
        runId: event.runId,
        kind: "tool_call",
        eventId: event.id,
        name: event.name,
        input: event.input,
      };
    case "tool_result":
      return {
        id: `${event.id}:result`,
        runId: event.runId,
        kind: "tool_result",
        eventId: event.id,
        name: event.name,
        output: event.output,
      };
    case "harness_start":
      return {
        id: `${event.runId}:start`,
        runId: event.runId,
        kind: "harness_start",
        agentId: event.agentId,
      };
    case "harness_end":
      return {
        id: `${event.runId}:end`,
        runId: event.runId,
        kind: "harness_end",
        agentId: event.agentId,
      };
    case "error":
      return {
        id: `err-${state.nextId}`,
        runId: event.runId,
        kind: "error",
        message: event.message,
      };
    case "usage":
      return {
        id: `usage-${state.nextId}`,
        runId: event.runId,
        kind: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case "relay":
      return {
        id: event.id,
        runId: event.runId,
        kind: "relay",
        relayId: event.id,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
    case "user":
      return { id: event.runId, runId: event.runId, kind: "user", content: event.content };
    default:
      return null;
  }
}
