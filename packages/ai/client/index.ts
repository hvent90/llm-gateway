// Core graph
export { createGraph, reduceEvent } from "./graph";
export type { GraphEvent } from "./graph";

// Conversation layer
export { createInitialConversation, reduceConversation } from "./conversation";

// Projections
export { projectThread } from "./projections/thread";
export type { ViewNode, ViewContent } from "./projections/thread";
export { projectMessages } from "./projections/messages";

// Types
export type { Graph, Node } from "./types";
export type { PendingRelay, ConversationState, ConversationEvent } from "./conversation";
export type { ServerEvent, StreamRequest } from "./server-event";

// Progress accumulation
export { accumulate } from "./progress";
export type { ToolProgressAccumulator } from "./progress";

// Transports
export { createSSETransport } from "./transports/sse";
export { createHTTPTransport } from "./transports/http";
