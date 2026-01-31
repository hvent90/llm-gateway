import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "fs";
import { log, resetForTesting } from "./logger";

const LOG_FILE = "logs/gateway.log";

beforeEach(() => {
  if (existsSync(LOG_FILE)) rmSync(LOG_FILE);
  resetForTesting();
});

function readLog(): string {
  return readFileSync(LOG_FILE, "utf-8");
}

describe("snapshot logger", () => {
  test("creates agent entry on first log call for a run", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1 max=10");
    const content = readLog();
    expect(content).toContain("=== agents ===");
    expect(content).toContain("aaa1111");
    expect(content).toContain("loop_iter");
  });

  test("tracks agent tree from agent_spawn and subagent_spawn", () => {
    log("I", "aaaa-1111", "agent_spawn", "model=test");
    log("I", "bbbb-2222", "subagent_spawn", "parent=aaaa-1111/tc1");
    const content = readLog();
    // Root agent should appear first
    expect(content).toContain("aaa1111");
    // Sub agent should appear indented after root
    expect(content.indexOf("aaa1111")).toBeLessThan(content.indexOf("bbb2222"));
    expect(content).toContain("└─");
  });

  test("updates phase on subsequent log calls for same run", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1 max=10");
    log("I", "aaaa-1111", "llm_call_start", "model=test");
    const content = readLog();
    // Agent tree should show latest phase
    const agentSection = content.split("=== agents ===")[1]!.split("===")[0]!;
    expect(agentSection).toContain("llm_call_start");
    expect(agentSection).not.toContain("loop_iter");
  });

  test("marks agent as done on no_tools phase", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1 max=10");
    log("I", "aaaa-1111", "no_tools");
    const content = readLog();
    const agentSection = content.split("=== agents ===")[1]!.split("===")[0]!;
    expect(agentSection).toContain("done");
  });

  test("keeps per-agent event buffer with last 20 events", () => {
    for (let i = 0; i < 25; i++) {
      log("I", "aaaa-1111", `phase_${i}`, `i=${i}`);
    }
    const content = readLog();
    // Should have agent's event section
    expect(content).toContain("aaa1111");
    // Should NOT have the first 5 events (evicted from buffer)
    expect(content).not.toContain("phase_0");
    expect(content).not.toContain("phase_4");
    // Should have the last 20
    expect(content).toContain("phase_5");
    expect(content).toContain("phase_24");
  });

  test("marks longest-stuck agent with <<<", () => {
    log("I", "aaaa-1111", "perm_wait", "tool=bash");
    // Need a second non-done agent so <<< marker activates
    log("I", "bbbb-2222", "subagent_spawn", "parent=aaaa-1111/tc1");
    log("I", "bbbb-2222", "llm_call_start", "model=test");
    // bbbb is still active (not done), aaaa's phaseStart is older
    const content = readLog();
    const agentSection = content.split("=== agents ===")[1]!.split("===")[0]!;
    const lines = agentSection.trim().split("\n");
    const aaaaLine = lines.find((l) => l.includes("aaa1111"))!;
    expect(aaaaLine).toContain("<<<");
  });

  test("per-agent sections are isolated", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1");
    log("I", "bbbb-2222", "loop_iter", "iter=1");
    log("I", "aaaa-1111", "llm_call_end", "dur=100ms");
    const content = readLog();
    // Extract per-agent sections by splitting on section header lines
    const sections = content.split(/^=== .+ last \d+ ===$/m);
    // sections[0] is everything before first agent section (the tree)
    // sections[1] is aaaa111's events, sections[2] is bbbb222's events
    const aaaaSection = sections[1]!;
    expect(aaaaSection).toContain("loop_iter");
    expect(aaaaSection).toContain("llm_call_end");
    // bbbb section should only have its event
    const bbbbSection = sections[2]!;
    expect(bbbbSection).toContain("loop_iter");
    expect(bbbbSection).not.toContain("llm_call_end");
  });

  test("resetForTesting clears all state", () => {
    log("I", "aaaa-1111", "loop_iter", "iter=1");
    resetForTesting();
    if (existsSync(LOG_FILE)) rmSync(LOG_FILE);
    log("I", "bbbb-2222", "loop_iter", "iter=1");
    const content = readLog();
    expect(content).not.toContain("aaa1111");
    expect(content).toContain("bbb2222");
  });
});
