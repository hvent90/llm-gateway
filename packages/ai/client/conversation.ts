import type { HarnessEvent } from "../types";
import type { GraphState } from "./types";
import { createInitialState, reduceEvent } from "./graph";

/**
 * User message in a conversation.
 */
export interface UserMessage {
  id: string;
  content: string;
  timestamp: number;
}

/**
 * Conversation state - composes graph with user messages.
 */
export interface ConversationState {
  graph: GraphState;
  userMessages: UserMessage[];
  pending: string | null;
  nextMessageId: number;
}

/**
 * Events the conversation layer handles.
 */
export type ConversationEvent =
  | { type: "user"; content: string; timestamp?: number }
  | HarnessEvent;

/**
 * Create empty conversation state.
 */
export function createInitialConversation(): ConversationState {
  return {
    graph: createInitialState(),
    userMessages: [],
    pending: null,
    nextMessageId: 1,
  };
}

/**
 * Reduce a conversation event.
 */
export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  if (event.type === "user") {
    const userMessage: UserMessage = {
      id: `user-${state.nextMessageId}`,
      content: event.content,
      timestamp: event.timestamp ?? Date.now(),
    };
    return {
      ...state,
      userMessages: [...state.userMessages, userMessage],
      nextMessageId: state.nextMessageId + 1,
    };
  }

  // It's a HarnessEvent - delegate to graph reducer
  return {
    ...state,
    graph: reduceEvent(state.graph, event),
  };
}
