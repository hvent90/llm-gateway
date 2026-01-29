import type { ServerEvent } from "./server-event";
import type { GraphState } from "./types";
import { createInitialState, reduceEvent } from "./graph";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: GraphState;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;
  isConnected: boolean;
}

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string;
  timestamp?: number;
};

export type ConversationEvent =
  | ServerEvent
  | UserEvent
  | { type: "stream_start" }
  | { type: "stream_end" }
  | { type: "relay_resolved"; relayId: string; tool: string; approved: boolean };

export function createInitialConversation(): ConversationState {
  return {
    graph: createInitialState(),
    sessionId: null,
    pendingRelays: [],
    grantedTools: new Set(),
    activeStreams: new Set(),
    isConnected: false,
  };
}

export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case "connected":
      return { ...state, sessionId: event.sessionId };

    case "user": {
      const runId = event.runId;
      const parentId = event.parentId;
      // Store a synthetic text event so getContentBlocks works
      const syntheticEvent = {
        type: "text" as const,
        id: runId,
        runId,
        agentId: runId,
        content: event.content,
      };
      const existingNode = state.graph.nodes.get(runId);
      const node = existingNode
        ? { ...existingNode, events: [...existingNode.events, syntheticEvent as ServerEvent] }
        : { runId, parentId, role: "user" as const, events: [syntheticEvent as ServerEvent] };
      const newNodes = new Map(state.graph.nodes);
      newNodes.set(runId, node);
      return { ...state, graph: { nodes: newNodes } };
    }

    case "relay": {
      const relay: PendingRelay = {
        relayId: event.id,
        runId: event.runId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
      // Also delegate to graph reducer so the relay event is tracked on the node
      return {
        ...state,
        pendingRelays: [...state.pendingRelays, relay],
        graph: reduceEvent(state.graph, event),
      };
    }

    case "relay_resolved": {
      const pendingRelays = state.pendingRelays.filter((r) => r.relayId !== event.relayId);
      const grantedTools = event.approved
        ? new Set([...state.grantedTools, event.tool])
        : state.grantedTools;
      return { ...state, pendingRelays, grantedTools };
    }

    case "stream_start":
      return { ...state, isConnected: true };

    case "stream_end":
      return { ...state, isConnected: false, activeStreams: new Set() };

    case "harness_start": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.add(event.runId);
      return { ...state, activeStreams, graph: reduceEvent(state.graph, event) };
    }

    case "harness_end": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.delete(event.runId);
      return { ...state, activeStreams, graph: reduceEvent(state.graph, event) };
    }

    default:
      return { ...state, graph: reduceEvent(state.graph, event as ServerEvent) };
  }
}
