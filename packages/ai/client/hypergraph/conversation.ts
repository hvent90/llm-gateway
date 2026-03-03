import type { ContentPart } from "../../types";
import type { ServerEvent } from "../server-event";
import type { ConversationGraph, NodeId } from "./types";
import { createGraph } from "./primitives";
import { reduceEvent, createReducerState, type GraphEvent, type ReducerState } from "./reducer";
export interface PendingRelay {
  relayId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface ConversationState {
  graph: ConversationGraph;
  reducerState: ReducerState;
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
    reducerState: createReducerState(),
    active: new Set(),
    sessionId: null,
    pendingRelays: [],
    isConnected: false,
  };
}

/**
 * Incrementally update the active set based on new message nodes added
 * by the reducer. This avoids the O(N) full-graph scan of defaultActive.
 *
 * New messages are identified by comparing messageCounter before/after.
 * Summary edges (which remove sources from active) are not created during
 * normal streaming, so we only handle them if detected.
 */
function updateActive(
  active: Set<NodeId>,
  oldMessageCounter: number,
  newMessageCounter: number,
): Set<NodeId> {
  for (let i = oldMessageCounter + 1; i <= newMessageCounter; i++) {
    active.add(`msg:${i}`);
  }
  return active;
}

function reduceAndUpdate(state: ConversationState, event: GraphEvent): ConversationState {
  const oldMsgCounter = state.reducerState.messageCounter;
  const [graph, reducerState] = reduceEvent(state.graph, state.reducerState, event);
  updateActive(state.active, oldMsgCounter, reducerState.messageCounter);
  // Return new object reference for Solid.js reactivity while sharing internals
  return { ...state, graph, reducerState };
}

export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case "connected":
      return { ...state, sessionId: event.sessionId };

    case "user":
      return reduceAndUpdate(state, event as GraphEvent);

    case "relay": {
      const relay: PendingRelay = {
        relayId: event.id,
        runId: event.runId,
        toolCallId: event.toolCallId,
        tool: event.tool,
        params: event.params,
      };
      state.pendingRelays = [...state.pendingRelays, relay];
      return reduceAndUpdate(state, event);
    }

    case "relay_resolved": {
      state.pendingRelays = state.pendingRelays.filter((r) => r.relayId !== event.relayId);
      return state;
    }

    case "stream_start":
      state.isConnected = true;
      return state;

    case "stream_end":
      state.isConnected = false;
      return state;

    case "harness_start":
      return reduceAndUpdate(state, event);

    case "harness_end":
      return reduceAndUpdate(state, event);

    default:
      return reduceAndUpdate(state, event as ServerEvent);
  }
}
