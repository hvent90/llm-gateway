export type { ServerEvent } from "../../../packages/ai/client/server-event";
export type { ConversationState, PendingRelay } from "../../../packages/ai/client/hypergraph";
export type {
  ConversationGraph,
  ConversationNode,
  NodeId,
} from "../../../packages/ai/client/hypergraph";
export type { ViewNode, ViewContent } from "../../../packages/ai/client/hypergraph";
export type { DAGNode, DAGEdge, DAGGroup, DAGLayout } from "../../../packages/ai/client/hypergraph";
export type {
  ReplData,
  ReplAgent,
  ReplTurn,
  ReplPhase,
} from "../../../packages/ai/client/hypergraph";
export type { Message } from "../../../packages/ai/types";

export interface ToolPermission {
  tool: string;
  params?: Record<string, string>;
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}
