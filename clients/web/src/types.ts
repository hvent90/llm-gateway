export type { ServerEvent } from "../../../packages/ai/client/server-event";
export type { ConversationState, PendingRelay } from "../../../packages/ai/client";
export type { Graph, Node } from "../../../packages/ai/client";
export type { ViewNode, ViewContent } from "../../../packages/ai/client";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolPermission {
  tool: string;
  params?: Record<string, string>;
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}
