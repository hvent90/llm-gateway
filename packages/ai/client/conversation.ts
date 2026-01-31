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
  grantedTools: Set<string>;
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
    graph: createGraph(),
    sessionId: null,
    pendingRelays: [],
    grantedTools: new Set(),
    isConnected: false,
  };
}

export function getAutoApprovableRelays(state: ConversationState): PendingRelay[] {
  return state.pendingRelays.filter((r) => state.grantedTools.has(r.tool));
}

export function getSameToolRelays(state: ConversationState, tool: string): PendingRelay[] {
  return state.pendingRelays.filter((r) => r.tool === tool);
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
      const grantedTools = event.approved
        ? new Set([...state.grantedTools, event.tool])
        : state.grantedTools;
      return { ...state, pendingRelays, grantedTools };
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
