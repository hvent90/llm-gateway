// Core graph
export { createGraph, reduceEvent } from "./graph";
export type { GraphEvent } from "./graph";

// Conversation layer
export { createInitialConversation, reduceConversation } from "./conversation";

// Projection
export { projectThread, getActiveRunIds } from "./projections/thread";
export type { ViewNode, ViewContent } from "./projections/thread";

// Types
export type { Graph, Node } from "./types";
export type { PendingRelay, ConversationState, ConversationEvent } from "./conversation";
export type { ServerEvent, StreamRequest } from "./server-event";

// Transports
export { createSSETransport } from "./transports/sse";
export { createHTTPTransport } from "./transports/http";
