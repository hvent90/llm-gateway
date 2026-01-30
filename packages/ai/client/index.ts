// Core graph
export { createInitialGraph, reduceGraphEvent } from "./graph";
export type { GraphEvent } from "./graph";

// Types
export type { Node, Graph, GraphBuilderState } from "./types";

// Projections
export { projectThread } from "./projections/thread";
export type { ViewNode, ViewContent } from "./projections/thread";

// Conversation layer
export {
  createInitialConversation,
  reduceConversation,
  getAutoApprovableRelays,
  getSameToolRelays,
} from "./conversation";
export type { PendingRelay, ConversationState, ConversationEvent } from "./conversation";

// Server event types
export type { ServerEvent, StreamRequest } from "./server-event";

// Transports
export { createSSETransport } from "./transports/sse";
export { createHTTPTransport } from "./transports/http";
