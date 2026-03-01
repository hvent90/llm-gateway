import type { z } from "zod";
import type { FileTime } from "./tools/lib/filetime";

// Core types for LLM Gateway harness interface

// Content part types for multipart messages (images, documents)
export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = { type: "image"; mediaType: string; data: string };
export type DocumentContentPart = { type: "document"; mediaType: string; data: string };
export type ContentPart = TextContentPart | ImageContentPart | DocumentContentPart;

// Message structure (follows OpenAI's pattern with dedicated tool role)
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string | ContentPart[] };

// Result from executing a tool
export interface ToolExecutionResult<T = unknown> {
  context?: string; // Injected into agent context window
  result?: T; // Available to harness/application
}

// Context passed to tool execute functions
export interface ToolContext {
  parentId?: string; // The tool_call ID that spawned this execution context
  spawn?: (task: string) => Promise<string>;
  fileTime?: FileTime;
}

// Tool definition (passed at request level)
export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  schema: TSchema;
  execute?: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolExecutionResult<TResult>>;
  derivePermission?: (params: Record<string, unknown>) => ToolPermission;
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

// Relay response types (one per relay kind)
export type PermissionResponse = { approved: boolean; reason?: string };

// Relay event — discriminated union on `kind`
export type RelayEvent = {
  type: "relay";
  kind: "permission";
  runId: string;
  id: string;
  parentId?: string;
  toolCallId: string;
  tool: string;
  params: Record<string, unknown>;
  respond: (response: PermissionResponse) => void;
};

// Events that a harness can yield during invocation
export type HarnessEvent =
  | {
      type: "harness_start";
      runId: string;
      parentId?: string;
      depth?: number;
      maxIterations?: number;
    }
  | {
      type: "harness_end";
      runId: string;
      parentId?: string;
      reason?: "final" | "max_iterations";
      iterations?: number;
      totalUsage?: { inputTokens: number; outputTokens: number };
    }
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
  | {
      type: "tool_progress";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      name: string;
      content: unknown;
    }
  | {
      type: "repl_input";
      runId: string;
      id: string;
      parentId?: string;
      code: string;
      iteration?: number;
    }
  | {
      type: "repl_progress";
      runId: string;
      id: string;
      parentId?: string;
      chunk: string;
      stream: "stdout" | "stderr";
    }
  | {
      type: "repl_output";
      runId: string;
      id: string;
      parentId?: string;
      stdout: string;
      error?: string;
      done: boolean;
      iteration?: number;
      durationMs?: number;
      truncated?: boolean;
    }
  | { type: "usage"; runId: string; parentId?: string; inputTokens: number; outputTokens: number }
  | { type: "error"; runId: string; parentId?: string; error: Error }
  | RelayEvent;

// Parameters for invoking a harness
export interface InvokeParams {
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  emit: (event: HarnessEvent) => void;
  context?: {
    parentId?: string;
  };
  permissions?: Permissions;
}

// Parameters for generator-based harness invocation (no emit callback)
export interface GeneratorInvokeParams {
  model?: string;
  messages: Message[];
  context?: string;
  tools?: ToolDefinition[];
  env?: {
    parentId?: string;
    spawn?: (task: string, parentId: string) => Promise<string>;
    fileTime?: FileTime;
  };
  permissions?: Permissions;
}

// The interface a harness module must implement
export interface HarnessModule {
  invoke(params: InvokeParams): Promise<void>;
  supportedModels(): Promise<string[]>;
}

// Generator-based harness module interface
export interface GeneratorHarnessModule {
  invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent>;
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
