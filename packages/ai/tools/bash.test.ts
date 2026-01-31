import { describe, test, expect } from "bun:test";
import { bashTool } from "./bash";

const ctx = {};

describe("bashTool", () => {
  test("defaults timeout to 5 seconds", () => {
    expect(bashTool.schema.parse({ command: "echo hi" })).toEqual({
      command: "echo hi",
      timeout: 5,
    });
  });

  test("accepts a custom timeout", () => {
    expect(bashTool.schema.parse({ command: "echo hi", timeout: 10 })).toEqual({
      command: "echo hi",
      timeout: 10,
    });
  });

  test("returns timeout message when command exceeds timeout", async () => {
    const { context } = await bashTool.execute!({ command: "sleep 10", timeout: 1 }, ctx);
    expect(context).toContain("timed out after 1 seconds");
  });

  test("kills child processes on timeout, not just the shell", async () => {
    // find spawns as a child of sh — if we only kill sh, find holds the pipe open forever
    const { context } = await bashTool.execute!(
      { command: "find / -type f 2>/dev/null", timeout: 1 },
      ctx,
    );
    expect(context).toContain("timed out after 1 seconds");
  });

  test("returns within bounded time even when pipeline holds pipes open", async () => {
    // Reproduces the real bug: a pipeline where the writer blocks forever.
    // `yes` writes infinite "y\n" lines → `sed` reads forever → pipe never closes.
    // Before the fix, killProcessTree runs but `await Response(proc.stdout).text()`
    // hangs because the sequential await must resolve before `if (timedOut)`.
    const timeoutSec = 1;
    const start = Date.now();
    const { context } = await bashTool.execute!(
      { command: "yes | sed ''", timeout: timeoutSec },
      ctx,
    );
    const elapsed = (Date.now() - start) / 1000;
    expect(context).toContain("timed out after 1 seconds");
    // Must return within 3s (generous buffer over the 1s timeout).
    // Before the fix, this hangs forever.
    expect(elapsed).toBeLessThan(timeoutSec + 2);
  });

  test("returns normal output when command completes within timeout", async () => {
    const { context } = await bashTool.execute!({ command: "echo hello", timeout: 5 }, ctx);
    expect(context).toContain("hello");
    expect(context).not.toContain("timed out");
  });
});
