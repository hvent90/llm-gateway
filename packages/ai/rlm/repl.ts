import type { LlmQueryFn, ReplExecutionResult, ReplState, SubRlmFn } from "./types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export interface ReplOptions {
  context: string;
  llmQuery: LlmQueryFn;
  subRlm?: SubRlmFn;
  maxStdoutLength?: number;
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
    sub_rlm:
      options.subRlm ??
      (() => {
        throw new Error("sub_rlm is not available in this REPL");
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
    const print = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    scope.print = print;
    scope.console = { log: print, warn: print, error: print };

    scope.FINAL = (answer: unknown) => {
      done = true;
      finalValue = String(answer);
    };

    scope.FINAL_VAR = (varName: string) => {
      done = true;
      finalValue = String(scope[varName]);
    };

    try {
      // Build an async function with `scope` as the single parameter.
      // Destructure built-in names as convenience locals.
      const builtins = [
        "context",
        "llm_query",
        "sub_rlm",
        "print",
        "console",
        "FINAL",
        "FINAL_VAR",
      ];
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
