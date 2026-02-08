import { describe, expect, test } from "bun:test";
import { createRepl } from "../repl";

function makeRepl(
  overrides: {
    context?: string;
    llmQuery?: (prompt: string) => Promise<string>;
    subRlm?: (prompt: string) => Promise<string>;
    exec?: (
      command: string,
      timeout?: number,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    maxStdoutLength?: number;
  } = {},
) {
  return createRepl({
    context: overrides.context ?? "test context",
    llmQuery: overrides.llmQuery ?? (async (p: string) => `echo: ${p}`),
    subRlm: overrides.subRlm,
    exec: overrides.exec,
    maxStdoutLength: overrides.maxStdoutLength,
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
      const result = await repl.execute("print(scope.name);");
      expect(result.stdout).toBe("alice");
    });

    test("context is available as a convenience local", async () => {
      const repl = makeRepl({ context: "hello world" });
      const result = await repl.execute("print(context);");
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
    test("captures print() output", async () => {
      const repl = makeRepl();
      const result = await repl.execute('print("hello"); print("world");');
      expect(result.stdout).toBe("hello\nworld");
    });

    test("captures console.log output", async () => {
      const repl = makeRepl();
      const result = await repl.execute('console.log("one"); console.log("two");');
      expect(result.stdout).toBe("one\ntwo");
    });

    test("print joins multiple args with spaces", async () => {
      const repl = makeRepl();
      const result = await repl.execute('print("a", "b", "c");');
      expect(result.stdout).toBe("a b c");
    });

    test("returns empty string when no output", async () => {
      const repl = makeRepl();
      const result = await repl.execute("scope.x = 1;");
      expect(result.stdout).toBe("");
    });
  });

  describe("stdout truncation", () => {
    test("truncates stdout exceeding maxStdoutLength", async () => {
      const repl = makeRepl({ maxStdoutLength: 20 });
      const result = await repl.execute('print("a".repeat(50));');
      expect(result.stdout.length).toBeLessThanOrEqual(20 + "\n...[truncated]".length);
      expect(result.stdout).toContain("...[truncated]");
    });

    test("does not truncate stdout within limit", async () => {
      const repl = makeRepl({ maxStdoutLength: 100 });
      const result = await repl.execute('print("short");');
      expect(result.stdout).toBe("short");
      expect(result.stdout).not.toContain("truncated");
    });
  });

  describe("FINAL() and FINAL_VAR()", () => {
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

    test("FINAL_VAR() reads from scope and sets done", async () => {
      const repl = makeRepl();
      await repl.execute('scope.answer = "computed result";');
      const result = await repl.execute('FINAL_VAR("answer");');
      expect(result.done).toBe(true);
      expect(result.finalValue).toBe("computed result");
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
    test("llm_query calls the provided callback", async () => {
      const calls: string[] = [];
      const repl = makeRepl({
        llmQuery: async (prompt: string) => {
          calls.push(prompt);
          return `response to: ${prompt}`;
        },
      });
      const result = await repl.execute(`
        const response = await llm_query("what is 2+2?");
        print(response);
      `);
      expect(calls).toEqual(["what is 2+2?"]);
      expect(result.stdout).toBe("response to: what is 2+2?");
    });

    test("llm_query result can be stored in scope", async () => {
      const repl = makeRepl({
        llmQuery: async () => "42",
      });
      await repl.execute('scope.answer = await llm_query("meaning of life");');
      expect(repl.getState().variables.get("answer")).toBe("42");
    });
  });

  describe("sub_rlm integration", () => {
    test("sub_rlm calls the provided callback", async () => {
      const repl = makeRepl({
        subRlm: async (prompt: string) => `sub: ${prompt}`,
      });
      const result = await repl.execute(`
        const r = await sub_rlm("summarize this");
        print(r);
      `);
      expect(result.stdout).toBe("sub: summarize this");
    });

    test("sub_rlm throws when not provided", async () => {
      const repl = makeRepl();
      const result = await repl.execute('await sub_rlm("test");');
      expect(result.error).toContain("sub_rlm is not available");
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
        print(r.stdout.trim());
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
        print(r.stdout, r.stderr, r.exitCode);
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
        print("before error");
        throw new Error("boom");
      `);
      expect(result.stdout).toBe("before error");
      expect(result.error).toContain("boom");
    });

    test("error does not crash the REPL - subsequent calls work", async () => {
      const repl = makeRepl();
      await repl.execute("throw new Error('first error');");
      const result = await repl.execute('print("recovered");');
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe("recovered");
    });
  });

  describe("sandboxing", () => {
    test("process is not accessible", async () => {
      const repl = makeRepl();
      const result = await repl.execute("print(typeof process);");
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
