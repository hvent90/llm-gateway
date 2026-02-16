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

export { reduceEvent } from "./reducer";
export type { GraphEvent } from "./reducer";

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
export type { ViewContent } from "./derived";

export { projectThread } from "./projections/thread";
export type { ViewNode } from "./projections/thread";

export { projectMessages } from "./projections/messages";
