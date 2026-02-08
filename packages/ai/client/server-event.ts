import type { Message, Permissions } from "../types";

/**
 * Events the server sends to clients over any transport.
 *
 * Differs from HarnessEvent:
 * - `connected` is a server-only event (not emitted by harnesses)
 * - `error` carries a message string (not an Error object)
 * - `relay` has `respond` stripped (clients resolve via HTTP)
 */
export type ServerEvent =
  | { type: "connected"; sessionId: string }
  | { type: "harness_start"; runId: string; agentId: string; parentId?: string }
  | { type: "harness_end"; runId: string; agentId: string; parentId?: string }
  | { type: "text"; id: string; runId: string; agentId: string; parentId?: string; content: string }
  | {
      type: "reasoning";
      id: string;
      runId: string;
      agentId: string;
      parentId?: string;
      content: string;
    }
  | {
      type: "tool_call";
      id: string;
      runId: string;
      agentId: string;
      parentId?: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      runId: string;
      agentId: string;
      parentId?: string;
      name: string;
      output: unknown;
    }
  | {
      type: "tool_progress";
      id: string;
      runId: string;
      agentId: string;
      parentId?: string;
      toolCallId: string;
      name: string;
      content: unknown;
    }
  | {
      type: "relay";
      kind: "permission";
      id: string;
      runId: string;
      agentId: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    }
  | {
      type: "usage";
      runId: string;
      agentId: string;
      parentId?: string;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: "error"; runId: string; agentId: string; parentId?: string; message: string };

/**
 * Request body for initiating a chat stream.
 */
export interface StreamRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
  mode?: "agent" | "rlm";
}
