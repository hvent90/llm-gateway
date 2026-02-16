import type { HarnessEvent } from "../../types";

export type NodeId = string;
export type EdgeId = string;

export type ConversationNode =
  | { id: NodeId; kind: "chunk"; content: HarnessEvent }
  | { id: NodeId; kind: "block" }
  | { id: NodeId; kind: "message" };

export type EdgeType = "sequence" | "block" | "message" | "summary" | "spawn";

export type EdgeRole =
  | "predecessor"
  | "successor"
  | "part"
  | "whole"
  | "source"
  | "result"
  | "trigger"
  | "invocation";

export type SequenceEdge = {
  id: EdgeId;
  type: "sequence";
  roles: { predecessor: NodeId[]; successor: NodeId[] };
  properties: Record<string, unknown>;
};
export type BlockEdge = {
  id: EdgeId;
  type: "block";
  roles: { part: NodeId[]; whole: NodeId[] };
  properties: Record<string, unknown>;
};
export type MessageEdge = {
  id: EdgeId;
  type: "message";
  roles: { part: NodeId[]; whole: NodeId[] };
  properties: Record<string, unknown>;
};
export type SummaryEdge = {
  id: EdgeId;
  type: "summary";
  roles: { source: NodeId[]; result: NodeId[] };
  properties: Record<string, unknown>;
};
export type SpawnEdge = {
  id: EdgeId;
  type: "spawn";
  roles: { trigger: NodeId[]; invocation: NodeId[] };
  properties: Record<string, unknown>;
};

export type HyperEdge = SequenceEdge | BlockEdge | MessageEdge | SummaryEdge | SpawnEdge;

export type ConversationGraph = {
  nodes: Map<NodeId, ConversationNode>;
  edges: Map<EdgeId, HyperEdge>;
};
