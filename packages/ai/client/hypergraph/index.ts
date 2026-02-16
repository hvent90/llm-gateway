export type {
  NodeId,
  EdgeId,
  ConversationNode,
  HyperEdge,
  SequenceEdge,
  BlockEdge,
  MessageEdge,
  SummaryEdge,
  SpawnEdge,
  ConversationGraph,
  EdgeType,
  EdgeRole,
} from "./types";

export { createGraph, addNode, addEdge, extendEdge, getNode, findEdges } from "./primitives";
export type { FindEdgesQuery } from "./primitives";

export { chunksOf, blocksOf, sourcesOf, blockOf, messageOf, summariesOf } from "./queries";

export { reduceEvent, createReducerState } from "./reducer";
export type { GraphEvent, ReducerState } from "./reducer";

export {
  defaultActive,
  fullHistoryActive,
  walk,
  findHead,
  findNextActive,
  findPrevActive,
  descendToFirstActive,
  findAggregate,
  validate,
} from "./walk";

export { deriveBlockContent, deriveMessageContent } from "./derived";
export type { BlockContent } from "./derived";

export { projectThread } from "./projections/thread";
export type { ViewNode, ViewContent } from "./projections/thread";

export { projectForceGraph } from "./projections/force-graph";
export type { ForceNode, ForceLink, ForceHull, ForceGraphData } from "./projections/force-graph";

export { projectMessages } from "./projections/messages";

export { expand, collapse, append, summarize, branch, toggle } from "./operations";

export { createInitialConversation, reduceConversation } from "./conversation";
export type { ConversationState, PendingRelay, ConversationEvent } from "./conversation";
