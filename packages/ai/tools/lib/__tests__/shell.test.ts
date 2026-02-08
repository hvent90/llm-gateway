import { describe, expect, test } from "bun:test";
import { execShell } from "../shell";

describe("execShell", () => {
  test("captures stdout from a command", async () => {
    const result = await execShell({ command: "echo hello" });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("captures stderr from a command", async () => {
    const result = await execShell({ command: "echo oops >&2" });
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(0);
  });

  test("returns non-zero exit code on failure", async () => {
    const result = await execShell({ command: "exit 42" });
    expect(result.exitCode).toBe(42);
  });

  test("times out long-running commands", async () => {
    const result = await execShell({ command: "sleep 30", timeout: 0.3 });
    expect(result.exitCode).toBe(-1);
  });

  test("uses default timeout of 5 seconds", async () => {
    const result = await execShell({ command: "echo fast" });
    expect(result.stdout.trim()).toBe("fast");
    expect(result.exitCode).toBe(0);
  });
});
