// Message types (matching server's packages/ai/types.ts)
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// Server event types
export type ServerEvent =
  | { type: "connected"; sessionId: string }
  | { type: "text"; runId: string; id: string; parentId?: string; content: string }
  | { type: "reasoning"; runId: string; id: string; parentId?: string; content: string }
  | {
      type: "tool_call";
      runId: string;
      id: string;
      parentId?: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      runId: string;
      id: string;
      parentId?: string;
      name: string;
      output: unknown;
    }
  | { type: "error"; runId: string; parentId?: string; message: string }
  | {
      type: "permission_required";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

// Tool call display
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
}

// Message node for tree display
export interface MessageNode {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string[];
  toolCalls: ToolCall[];
  children: MessageNode[];
}

// Permission request
export interface PermissionRequest {
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
  pendingPermission: PermissionRequest | null;
  grantedTools: Set<string>;
}
