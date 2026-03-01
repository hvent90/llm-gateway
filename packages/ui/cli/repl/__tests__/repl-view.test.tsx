import { describe, test, expect } from "bun:test";
import type { ReplData } from "../../../../ai/client/hypergraph";
import { flattenAgents, type FlatEntry } from "../sidebar";

const EMPTY_DATA: ReplData = { agents: [], allAgents: new Map() };

const MOCK_DATA: ReplData = (() => {
  const agent = {
    runId: "run-1",
    agentId: "agent-abc1234",
    status: "running" as const,
    depth: 0,
    turns: [
      {
        iteration: 1,
        phase: "done" as const,
        reasoning: "Let me think about this",
        code: 'console.log("hello")',
        stdout: "hello\n",
        stderr: "",
        output: { stdout: "hello\n", durationMs: 42, done: false },
        errorMessage: null,
        childAgents: [],
      },
      {
        iteration: 2,
        phase: "executing" as const,
        reasoning: "Now the next step",
        code: "const x = 1 + 2;",
        stdout: "",
        stderr: "",
        output: null,
        errorMessage: null,
        childAgents: [],
      },
    ],
    finalAnswer: null,
    totalUsage: { inputTokens: 1000, outputTokens: 500 },
  };

  const child = {
    runId: "run-2",
    agentId: "agent-def5678",
    parentId: "run-1",
    status: "done" as const,
    depth: 1,
    turns: [
      {
        iteration: 1,
        phase: "done" as const,
        reasoning: "Sub-task reasoning",
        code: "return 42;",
        stdout: "42\n",
        stderr: "",
        output: { stdout: "42\n", durationMs: 10, done: true },
        errorMessage: null,
        childAgents: [],
      },
    ],
    finalAnswer: "The answer is 42",
    totalUsage: { inputTokens: 200, outputTokens: 100 },
  };

  agent.turns[0]!.childAgents = [child];

  const allAgents = new Map();
  allAgents.set("run-1", agent);
  allAgents.set("run-2", child);

  return { agents: [agent], allAgents };
})();

describe("flattenAgents", () => {
  test("returns empty for no agents", () => {
    const entries = flattenAgents([]);
    expect(entries).toEqual([]);
  });

  test("flattens agent tree with turns and children", () => {
    const entries = flattenAgents(MOCK_DATA.agents);
    const types = entries.map((e) => `${e.type}:${e.runId.slice(-1)}:d${e.depth}`);
    expect(types).toEqual([
      "agent:1:d0", // root agent
      "turn:1:d1", // turn 1
      "agent:2:d2", // child agent (nested under turn 1)
      "turn:2:d3", // child's turn 1
      "turn:1:d1", // turn 2
    ]);
  });

  test("turn entries have correct turnIndex", () => {
    const entries = flattenAgents(MOCK_DATA.agents);
    const turnEntries = entries.filter((e) => e.type === "turn");
    expect(turnEntries.map((e) => e.turnIndex)).toEqual([0, 0, 1]);
  });
});

describe("ReplView exports", () => {
  test("barrel export exposes expected symbols", async () => {
    const mod = await import("../index");
    expect(mod.ReplView).toBeDefined();
    expect(typeof mod.ReplView).toBe("function");
  });
});
