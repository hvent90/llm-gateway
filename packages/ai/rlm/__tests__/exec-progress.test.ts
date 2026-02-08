import { describe, test, expect } from "bun:test";
import { execAccumulator, type ExecProgressState } from "../exec-progress";

describe("exec progress accumulator", () => {
  test("init returns empty state", () => {
    const state = execAccumulator.init();
    expect(state).toEqual({ stdout: "", stderr: "", metrics: null });
  });

  test("stdout chunk appends to stdout buffer", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stdout", data: "hello\n" });
    expect(state.stdout).toBe("hello\n");
    expect(state.stderr).toBe("");
  });

  test("stderr chunk appends to stderr buffer", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stderr", data: "warn\n" });
    expect(state.stderr).toBe("warn\n");
    expect(state.stdout).toBe("");
  });

  test("multiple stdout chunks accumulate", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stdout", data: "line1\n" });
    state = execAccumulator.reduce(state, { channel: "stdout", data: "line2\n" });
    expect(state.stdout).toBe("line1\nline2\n");
  });

  test("metrics replace previous metrics", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, {
      pid: 123,
      cpuPercent: 50,
      rssKb: 1024,
      wallMs: 1000,
    });
    expect(state.metrics).toEqual({ pid: 123, cpuPercent: 50, rssKb: 1024, wallMs: 1000 });

    state = execAccumulator.reduce(state, {
      pid: 123,
      cpuPercent: 25,
      rssKb: 2048,
      wallMs: 2000,
    });
    expect(state.metrics).toEqual({ pid: 123, cpuPercent: 25, rssKb: 2048, wallMs: 2000 });
  });

  test("interleaved stdout, stderr, and metrics", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { channel: "stdout", data: "out1\n" });
    state = execAccumulator.reduce(state, { pid: 1, cpuPercent: 10, rssKb: 100, wallMs: 500 });
    state = execAccumulator.reduce(state, { channel: "stderr", data: "err1\n" });
    state = execAccumulator.reduce(state, { channel: "stdout", data: "out2\n" });
    state = execAccumulator.reduce(state, { pid: 1, cpuPercent: 20, rssKb: 200, wallMs: 1500 });

    expect(state.stdout).toBe("out1\nout2\n");
    expect(state.stderr).toBe("err1\n");
    expect(state.metrics).toEqual({ pid: 1, cpuPercent: 20, rssKb: 200, wallMs: 1500 });
  });

  test("unrecognized content shape is ignored", () => {
    let state = execAccumulator.init();
    state = execAccumulator.reduce(state, { something: "unknown" });
    expect(state).toEqual({ stdout: "", stderr: "", metrics: null });
  });
});
