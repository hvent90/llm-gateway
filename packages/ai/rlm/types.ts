// Types for Recursive Language Model (RLM) invocation
// RLMs treat LLM input as a REPL environment variable, allowing
// programmatic recursion over arbitrarily long contexts.

/** Configuration for an RLM invocation */
export interface RlmConfig {
  /** Max REPL iterations before forcing completion */
  maxIterations: number;
  /** Max stdout characters to feed back per turn */
  maxStdoutLength: number;
  /** Length of context prefix shown in metadata */
  metadataPrefixLength: number;
  /** Model for sub-LLM calls (llm_query). Defaults to the model passed at invoke time. */
  subModel?: string;
  /** Max character length for llm_query prompt (instructions). Defaults to 10000. Keeps prompts short — data belongs in context. */
  subPromptBudget?: number;
  /** Max recursion depth for llm_query. At depth > 0, llm_query spawns a full child RLM session. At depth 0, it falls back to a flat one-shot call. Default: 2. */
  maxDepth?: number;
  /** Default timeout in seconds for exec() calls (default: 10) */
  execTimeout?: number;
  /** Working directory for exec() calls. Defaults to the current process cwd. */
  execCwd?: string;
}

/** State of the REPL environment */
export interface ReplState {
  /** Named variables in scope */
  variables: Map<string, unknown>;
  /** Whether FINAL() has been called */
  done: boolean;
  /** The final answer value, if done */
  finalValue?: string;
}

/** Result of executing code in the REPL */
export interface ReplExecutionResult {
  /** Captured stdout output */
  stdout: string;
  /** Whether FINAL() was called */
  done: boolean;
  /** The final answer, if done */
  finalValue?: string;
  /** Error message if execution failed */
  error?: string;
  /** Whether stdout was truncated to fit maxStdoutLength */
  truncated?: boolean;
}

/** Callback type for llm_query inside the REPL */
export type LlmQueryFn = (prompt: string, context?: string) => Promise<string>;

/** Result of a shell command execution */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Callback type for exec inside the REPL */
export type ExecFn = (command: string, timeout?: number) => Promise<ShellResult>;
