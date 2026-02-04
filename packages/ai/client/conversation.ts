import type { ContentPart } from "../types";
import type { ServerEvent } from "./server-event";
import type { Graph } from "./types";
import { createGraph, reduceEvent, type GraphEvent } from "./graph";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: Graph;
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

    case "user":
      return { ...state, graph: reduceEvent(state.graph, event as GraphEvent) };

    case "relay": {
      const relay: PendingRelay = {
        relayId: event.id,
        runId: event.runId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
      return {
        ...state,
        pendingRelays: [...state.pendingRelays, relay],
        graph: reduceEvent(state.graph, event),
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

    case "harness_start":
      return { ...state, graph: reduceEvent(state.graph, event) };

    case "harness_end":
      return { ...state, graph: reduceEvent(state.graph, event) };

    default:
      return { ...state, graph: reduceEvent(state.graph, event as ServerEvent) };
  }
}
