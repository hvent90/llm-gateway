import type { ContentPart } from "../../types";
import type { ServerEvent } from "../server-event";
import type { ConversationGraph, NodeId } from "./types";
import { createGraph } from "./primitives";
import { reduceEvent, type GraphEvent } from "./reducer";
import { defaultActive } from "./walk";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: ConversationGraph;
  active: Set<NodeId>;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  isConnected: boolean;
}

type UserEvent = {
  type: "user";
  runId: string;
  parentId?: string;
  content: string | ContentPart[];
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
    graph: createGraph(),
    active: new Set(),
    sessionId: null,
    pendingRelays: [],
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
      const graph = reduceEvent(state.graph, event as GraphEvent);
      return { ...state, graph, active: defaultActive(graph) };
    }

    case "relay": {
      const relay: PendingRelay = {
        relayId: event.id,
        runId: event.runId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
      const graph = reduceEvent(state.graph, event);
      return {
        ...state,
        pendingRelays: [...state.pendingRelays, relay],
        graph,
        active: defaultActive(graph),
      };
    }

    case "relay_resolved": {
      const pendingRelays = state.pendingRelays.filter((r) => r.relayId !== event.relayId);
      return { ...state, pendingRelays };
    }

    case "stream_start":
      return { ...state, isConnected: true };

    case "stream_end":
      return { ...state, isConnected: false };

    case "harness_start": {
      const graph = reduceEvent(state.graph, event);
      return { ...state, graph, active: defaultActive(graph) };
    }

    case "harness_end": {
      const graph = reduceEvent(state.graph, event);
      return { ...state, graph, active: defaultActive(graph) };
    }

    default: {
      const graph = reduceEvent(state.graph, event as ServerEvent);
      return { ...state, graph, active: defaultActive(graph) };
    }
  }
}
