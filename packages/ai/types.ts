import type { z } from "zod";

// Core types for LLM Gateway harness interface

// Message structure (follows OpenAI's pattern with dedicated tool role)
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// Result from executing a tool
export interface ToolExecutionResult<T = unknown> {
  context?: string; // Injected into agent context window
  result?: T; // Available to harness/application
}

// Context passed to tool execute functions
export interface ToolContext {
  emit: (event: HarnessEvent) => void;
  parentId?: string; // The tool_call ID that spawned this execution context
}

// Tool definition (passed at request level)
export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  schema: TSchema;
  execute?: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolExecutionResult<TResult>>;
}

// Tool call (in assistant messages)
export interface ToolCall<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  name: string;
  arguments?: z.infer<TSchema>;
}

// Permission types for tool execution control
export interface ToolPermission {
  tool: string;
  params?: Record<string, string>; // param name → glob pattern
}

export interface Permissions {
  allowlist?: ToolPermission[];
  allowOnce?: ToolPermission[];
  deny?: Array<{ toolCallId: string; reason?: string }>;
}

// Events that a harness can yield during invocation
export type HarnessEvent =
  | { type: "reasoning"; runId: string; id: string; parentId?: string; content: string }
  | { type: "text"; runId: string; id: string; parentId?: string; content: string }
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
  | { type: "error"; runId: string; parentId?: string; error: Error }
  | {
      type: "permission_required";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      tool: string;
      params: Record<string, unknown>;
    };

// Parameters for invoking a harness
export interface InvokeParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  emit: (event: HarnessEvent) => void;
  context?: {
    runId?: string;
    parentId?: string;
  };
  permissions?: Permissions;
}

// The interface a harness module must implement
export interface HarnessModule {
  invoke(params: InvokeParams): Promise<void>;
  supportedModels(): Promise<string[]>;
}

// Harness metadata
export interface Harness {
  id: string;
  name: string;
  description?: string;
  modulePath?: string;
  supportedModels?: string[];
  registeredAt?: number;
}

// A loaded harness with its module
export interface LoadedHarness {
  harness: Harness;
  module: HarnessModule;
}
