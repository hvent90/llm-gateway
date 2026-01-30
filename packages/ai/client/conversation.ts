import type { ServerEvent } from "./server-event";
import type { GraphBuilderState } from "./types";
import { createInitialGraph, reduceGraphEvent } from "./graph";
import type { GraphEvent } from "./graph";

export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: GraphBuilderState;
  sessionId: string | null;
  pendingRelays: PendingRelay[];
  grantedTools: Set<string>;
  activeStreams: Set<string>;
  isConnected: boolean;
}

export type ConversationEvent =
  | ServerEvent
  | { type: "user"; runId: string; parentId?: string; content: string; timestamp?: number }
  | { type: "stream_start" }
  | { type: "stream_end" }
  | { type: "relay_resolved"; relayId: string; tool: string; approved: boolean };

export function createInitialConversation(): ConversationState {
  return {
    graph: createInitialGraph(),
    sessionId: null,
    pendingRelays: [],
    grantedTools: new Set(),
    activeStreams: new Set(),
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
      return { ...state, graph: reduceGraphEvent(state.graph, event) };

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
        graph: reduceGraphEvent(state.graph, event),
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
      return { ...state, activeStreams, graph: reduceGraphEvent(state.graph, event) };
    }

    case "harness_end": {
      const activeStreams = new Set(state.activeStreams);
      activeStreams.delete(event.runId);
      return { ...state, activeStreams, graph: reduceGraphEvent(state.graph, event) };
    }

    default:
      return { ...state, graph: reduceGraphEvent(state.graph, event as ServerEvent) };
  }
}
