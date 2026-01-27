// Message types (matching server's packages/ai/types.ts)
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Server event types — re-exported from library
export type { ServerEvent } from "../../../packages/ai/client/server-event";

// Tool call display
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
}

// Content blocks for ordered rendering
export type ContentBlock =
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "text"; content: string };

// Message node for tree display
export interface MessageNode {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  contentBlocks: ContentBlock[];
  children: MessageNode[];
}

// Relay request (pending relay requiring user input)
export interface RelayRequest {
  relayId: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
}

// Permission types (matching server's packages/ai/types.ts)
export interface ToolPermission {
  tool: string;
  params?: Record<string, string>;
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}

// Conversation state
export interface ConversationState {
  sessionId: string | null;
  messages: MessageNode[];
  isStreaming: boolean;
  pendingRelay: RelayRequest | null;
  grantedTools: Set<string>;
}
