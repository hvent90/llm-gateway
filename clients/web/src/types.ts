// Re-export shared types
export type { ServerEvent } from "../../../packages/ai/client/server-event";
export type { ConversationState, PendingRelay } from "../../../packages/ai/client";
export type { ContentBlock } from "../../../packages/ai/client";
export type { GraphState } from "../../../packages/ai/client";

// Message structure for API requests
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Permission types
export interface ToolPermission {
  tool: string;
  params?: Record<string, string>;
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}
