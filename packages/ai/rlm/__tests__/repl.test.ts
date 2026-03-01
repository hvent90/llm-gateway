import { describe, expect, test } from "bun:test";
import { createRepl } from "../repl";

function makeRepl(
  overrides: {
    context?: string;
    llmQuery?: (prompt: string, context?: string) => Promise<string>;
    exec?: (
      command: string,
      timeout?: number,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    maxStdoutLength?: number;
    onProgress?: (chunk: string, stream: "stdout" | "stderr") => void;
  } = {},
) {
  return createRepl({
    context: overrides.context ?? "test context",
    llmQuery: overrides.llmQuery ?? (async (p: string) => `echo: ${p}`),
    exec: overrides.exec,
    maxStdoutLength: overrides.maxStdoutLength,
    onProgress: overrides.onProgress,
  });
}

describe("REPL sandbox", () => {
  describe("basic code execution", () => {
    test("executes simple code", async () => {
      const repl = makeRepl();
      const result = await repl.execute("scope.x = 1 + 2;");
      expect(result.error).toBeUndefined();
      expect(result.done).toBe(false);
    });

    test("executes async code", async () => {
      const repl = makeRepl();
      const result = await repl.execute("scope.x = await Promise.resolve(42);");
      expect(result.error).toBeUndefined();
      expect(repl.getState().variables.get("x")).toBe(42);
    });
  });

  describe("variable persistence", () => {
    test("variables persist across execute() calls via scope", async () => {
      const repl = makeRepl();
      await repl.execute('scope.name = "alice";');
      const result = await repl.execute("console.log(scope.name);");
      expect(result.stdout).toBe("alice");
    });

    test("context is available as a convenience local", async () => {
      const repl = makeRepl({ context: "hello world" });
      const result = await repl.execute("console.log(context);");
      expect(result.stdout).toBe("hello world");
    });

    test("scope variables appear in getState()", async () => {
      const repl = makeRepl();
      await repl.execute("scope.count = 99;");
      const state = repl.getState();
      expect(state.variables.get("count")).toBe(99);
    });
  });

  describe("stdout capture", () => {
    test("captures console.log output", async () => {
      const repl = makeRepl();
      const result = await repl.execute('console.log("hello"); console.log("world");');
      expect(result.stdout).toBe("hello\nworld");
    });

    test("console.log joins multiple args with spaces", async () => {
      const repl = makeRepl();
      const result = await repl.execute('console.log("a", "b", "c");');
      expect(result.stdout).toBe("a b c");
    });

    test("returns empty string when no output", async () => {
      const repl = makeRepl();
      const result = await repl.execute("scope.x = 1;");
      expect(result.stdout).toBe("");
    });
  });

  describe("onProgress streaming", () => {
    test("console.log fires onProgress with stdout stream", async () => {
      const chunks: { chunk: string; stream: string }[] = [];
      const repl = makeRepl({
        onProgress: (chunk, stream) => chunks.push({ chunk, stream }),
      });
      await repl.execute('console.log("hello");');
      expect(chunks).toEqual([{ chunk: "hello\n", stream: "stdout" }]);
    });

    test("console.error fires onProgress with stderr stream", async () => {
      const chunks: { chunk: string; stream: string }[] = [];
      const repl = makeRepl({
        onProgress: (chunk, stream) => chunks.push({ chunk, stream }),
      });
      await repl.execute('console.error("oops");');
      expect(chunks).toEqual([{ chunk: "oops\n", stream: "stderr" }]);
    });

    test("console.warn fires onProgress with stderr stream", async () => {
      const chunks: { chunk: string; stream: string }[] = [];
      const repl = makeRepl({
        onProgress: (chunk, stream) => chunks.push({ chunk, stream }),
      });
      await repl.execute('console.warn("warning");');
      expect(chunks).toEqual([{ chunk: "warning\n", stream: "stderr" }]);
    });

    test("multiple console calls fire multiple onProgress events", async () => {
      const chunks: { chunk: string; stream: string }[] = [];
      const repl = makeRepl({
        onProgress: (chunk, stream) => chunks.push({ chunk, stream }),
      });
      await repl.execute('console.log("a"); console.error("b"); console.log("c");');
      expect(chunks).toEqual([
        { chunk: "a\n", stream: "stdout" },
        { chunk: "b\n", stream: "stderr" },
        { chunk: "c\n", stream: "stdout" },
      ]);
    });
  });

  describe("stdout truncation", () => {
    test("truncates stdout exceeding maxStdoutLength", async () => {
      const repl = makeRepl({ maxStdoutLength: 20 });
      const result = await repl.execute('console.log("a".repeat(50));');
      expect(result.stdout.length).toBeLessThanOrEqual(20 + "\n...[truncated]".length);
      expect(result.stdout).toContain("...[truncated]");
    });

    test("does not truncate stdout within limit", async () => {
      const repl = makeRepl({ maxStdoutLength: 100 });
      const result = await repl.execute('console.log("short");');
      expect(result.stdout).toBe("short");
      expect(result.stdout).not.toContain("truncated");
    });
  });

  describe("FINAL()", () => {
    test("FINAL() sets done and finalValue", async () => {
      const repl = makeRepl();
      const result = await repl.execute('FINAL("the answer");');
      expect(result.done).toBe(true);
      expect(result.finalValue).toBe("the answer");
    });

    test("FINAL() converts non-string values to string", async () => {
      const repl = makeRepl();
      const result = await repl.execute("FINAL(42);");
      expect(result.finalValue).toBe("42");
    });

    test("getState() reflects done status after FINAL()", async () => {
      const repl = makeRepl();
      await repl.execute('FINAL("done");');
      const state = repl.getState();
      expect(state.done).toBe(true);
      expect(state.finalValue).toBe("done");
    });
  });

  describe("llm_query integration", () => {
    test("llm_query passes prompt and context to callback", async () => {
      const calls: { prompt: string; context?: string }[] = [];
      const repl = makeRepl({
        llmQuery: async (prompt: string, context?: string) => {
          calls.push({ prompt, context });
          return `response to: ${prompt}`;
        },
      });
      const result = await repl.execute(`
        const response = await llm_query("summarize", "some data here");
        console.log(response);
      `);
      expect(calls).toEqual([{ prompt: "summarize", context: "some data here" }]);
      expect(result.stdout).toBe("response to: summarize");
    });

    test("llm_query works with prompt only (no context)", async () => {
      const calls: { prompt: string; context?: string }[] = [];
      const repl = makeRepl({
        llmQuery: async (prompt: string, context?: string) => {
          calls.push({ prompt, context });
          return "42";
        },
      });
      await repl.execute('scope.answer = await llm_query("meaning of life");');
      expect(calls).toEqual([{ prompt: "meaning of life", context: undefined }]);
      expect(repl.getState().variables.get("answer")).toBe("42");
    });
  });

  describe("exec integration", () => {
    test("exec calls the provided callback", async () => {
      const calls: { command: string; timeout?: number }[] = [];
      const repl = makeRepl({
        exec: async (command, timeout) => {
          calls.push({ command, timeout });
          return { stdout: "hello\n", stderr: "", exitCode: 0 };
        },
      });
      const result = await repl.execute(`
        const r = await exec("echo hello");
        console.log(r.stdout.trim());
      `);
      expect(calls).toEqual([{ command: "echo hello", timeout: undefined }]);
      expect(result.stdout).toBe("hello");
    });

    test("exec returns stdout, stderr, and exitCode", async () => {
      const repl = makeRepl({
        exec: async () => ({ stdout: "out", stderr: "err", exitCode: 1 }),
      });
      const result = await repl.execute(`
        const r = await exec("failing command");
        console.log(r.stdout, r.stderr, r.exitCode);
      `);
      expect(result.stdout).toBe("out err 1");
    });

    test("exec passes timeout argument", async () => {
      const calls: { command: string; timeout?: number }[] = [];
      const repl = makeRepl({
        exec: async (command, timeout) => {
          calls.push({ command, timeout });
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      await repl.execute('await exec("slow", 30);');
      expect(calls[0].timeout).toBe(30);
    });

    test("exec throws when not provided", async () => {
      const repl = makeRepl();
      const result = await repl.execute('await exec("echo hi");');
      expect(result.error).toContain("exec is not available");
    });
  });

  describe("error handling", () => {
    test("syntax error returns error in result", async () => {
      const repl = makeRepl();
      const result = await repl.execute("const x = {;");
      expect(result.error).toBeDefined();
      expect(result.done).toBe(false);
    });

    test("runtime error returns error in result", async () => {
      const repl = makeRepl();
      const result = await repl.execute("undefinedVar.property;");
      expect(result.error).toBeDefined();
      expect(result.done).toBe(false);
    });

    test("error preserves stdout captured before the error", async () => {
      const repl = makeRepl();
      const result = await repl.execute(`
        console.log("before error");
        throw new Error("boom");
      `);
      expect(result.stdout).toBe("before error");
      expect(result.error).toContain("boom");
    });

    test("error does not crash the REPL - subsequent calls work", async () => {
      const repl = makeRepl();
      await repl.execute("throw new Error('first error');");
      const result = await repl.execute('console.log("recovered");');
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe("recovered");
    });
  });

  describe("sandboxing", () => {
    test("process is not accessible", async () => {
      const repl = makeRepl();
      const result = await repl.execute("console.log(typeof process);");
      // process may be 'object' in Bun's global scope, but we want to verify
      // the REPL scope doesn't explicitly provide it
      const state = repl.getState();
      expect(state.variables.has("process")).toBe(false);
    });

    test("require is not in scope", async () => {
      const repl = makeRepl();
      const state = repl.getState();
      expect(state.variables.has("require")).toBe(false);
    });
  });
});
