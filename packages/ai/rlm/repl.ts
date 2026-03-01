import type { ExecFn, LlmQueryFn, ReplExecutionResult, ReplState } from "./types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export interface ReplOptions {
  context: string;
  llmQuery: LlmQueryFn;
  exec?: ExecFn;
  maxStdoutLength?: number;
  onProgress?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface Repl {
  execute(code: string): Promise<ReplExecutionResult>;
  getState(): ReplState;
}

const DEFAULT_MAX_STDOUT = 4000;

export function createRepl(options: ReplOptions): Repl {
  const maxStdout = options.maxStdoutLength ?? DEFAULT_MAX_STDOUT;

  // The scope object persists across execute() calls.
  // Built-in functions and the context are pre-populated.
  // The model assigns persistent variables as scope.varName = value.
  const scope: Record<string, unknown> = {
    context: options.context,
    llm_query: options.llmQuery,
    exec:
      options.exec ??
      (() => {
        throw new Error("exec is not available in this REPL");
      }),
  };

  let done = false;
  let finalValue: string | undefined;

  function truncate(s: string): string {
    if (s.length <= maxStdout) return s;
    return s.slice(0, maxStdout) + "\n...[truncated]";
  }

  async function execute(code: string): Promise<ReplExecutionResult> {
    const logs: string[] = [];

    // Inject per-execution helpers into scope
    const log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      logs.push(line);
      options.onProgress?.(line + "\n", "stdout");
    };

    const warn = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      logs.push(line);
      options.onProgress?.(line + "\n", "stderr");
    };

    scope.console = { log, warn, error: warn };

    scope.FINAL = (answer: unknown) => {
      done = true;
      finalValue = String(answer);
    };

    try {
      // Build an async function with `scope` as the single parameter.
      // Destructure built-in names as convenience locals.
      const builtins = ["context", "llm_query", "exec", "console", "FINAL"];
      const destructure = builtins.map((name) => `  const ${name} = scope["${name}"];`).join("\n");

      const wrappedCode = `${destructure}\n${code}`;
      const fn = new AsyncFunction("scope", wrappedCode);
      await fn(scope);
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      return { stdout: truncate(logs.join("\n")), done: false, error };
    }

    const stdout = truncate(logs.join("\n"));
    return {
      stdout,
      done,
      ...(done && finalValue !== undefined ? { finalValue } : {}),
    };
  }

  function getState(): ReplState {
    return {
      variables: new Map(Object.entries(scope)),
      done,
      ...(done && finalValue !== undefined ? { finalValue } : {}),
    };
  }

  return { execute, getState };
}
