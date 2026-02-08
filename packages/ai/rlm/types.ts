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
}

/** State of the REPL environment */
export interface ReplState {
  /** Named variables in scope */
  variables: Map<string, unknown>;
  /** Whether FINAL() or FINAL_VAR() has been called */
  done: boolean;
  /** The final answer value, if done */
  finalValue?: string;
}

/** Result of executing code in the REPL */
export interface ReplExecutionResult {
  /** Captured stdout output */
  stdout: string;
  /** Whether FINAL()/FINAL_VAR() was called */
  done: boolean;
  /** The final answer, if done */
  finalValue?: string;
  /** Error message if execution failed */
  error?: string;
}

/** Callback type for llm_query inside the REPL */
export type LlmQueryFn = (prompt: string) => Promise<string>;

/** Callback type for sub_rlm inside the REPL */
export type SubRlmFn = (prompt: string) => Promise<string>;
