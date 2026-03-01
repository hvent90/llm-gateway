import { describe, test, expect } from "bun:test";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState } from "../../reducer";
import { projectRepl } from "../../projections/repl";
import type { ConversationGraph } from "../../types";

type GraphEvent = any;

function buildGraph(events: GraphEvent[]): ConversationGraph {
  let g = createGraph();
  let s = createReducerState();
  for (const e of events) [g, s] = reduceEvent(g, s, e);
  return g;
}

describe("projectRepl", () => {
  test("single turn: harness_start → text → repl_input → repl_progress → repl_output → harness_end", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm", depth: 0, maxIterations: 10 },
      { type: "text", id: "t1", runId: "r1", agentId: "rlm", content: "Let me think..." },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: "console.log(1+1)",
        iteration: 1,
      },
      {
        type: "repl_progress",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        chunk: "2\n",
        stream: "stdout",
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "2\n",
        done: false,
        iteration: 1,
        durationMs: 50,
      },
      { type: "harness_end", runId: "r1", agentId: "rlm", reason: "final" },
    ]);

    const data = projectRepl(g);
    expect(data.agents.length).toBe(1);

    const agent = data.agents[0]!;
    expect(agent.runId).toBe("r1");
    expect(agent.agentId).toBe("rlm");
    expect(agent.depth).toBe(0);
    expect(agent.maxIterations).toBe(10);
    expect(agent.status).toBe("done");
    expect(agent.turns.length).toBe(1);

    const turn = agent.turns[0]!;
    expect(turn.reasoning).toBe("Let me think...");
    expect(turn.code).toBe("console.log(1+1)");
    expect(turn.stdout).toBe("2\n");
    expect(turn.output).not.toBeNull();
    expect(turn.output!.stdout).toBe("2\n");
    expect(turn.output!.durationMs).toBe(50);
  });

  test("multi-turn: 2 iterations before FINAL", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      { type: "text", id: "t1", runId: "r1", agentId: "rlm", content: "First try" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: "1+1",
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "2",
        done: false,
        iteration: 1,
      },
      { type: "text", id: "t2", runId: "r1", agentId: "rlm", content: "Not right, try again" },
      {
        type: "repl_input",
        id: "ri2",
        runId: "r1",
        agentId: "rlm",
        code: "2+2",
        iteration: 2,
      },
      {
        type: "repl_output",
        id: "ri2",
        runId: "r1",
        agentId: "rlm",
        stdout: "4",
        done: false,
        iteration: 2,
      },
      { type: "harness_end", runId: "r1", agentId: "rlm", reason: "final" },
    ]);

    const data = projectRepl(g);
    const agent = data.agents[0]!;
    expect(agent.turns.length).toBe(2);
    expect(agent.turns[0]!.code).toBe("1+1");
    expect(agent.turns[0]!.reasoning).toBe("First try");
    expect(agent.turns[1]!.code).toBe("2+2");
    expect(agent.turns[1]!.reasoning).toBe("Not right, try again");
  });

  test("FINAL: repl_output.done=true → text (final answer) → harness_end", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: 'FINAL("42")',
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "",
        done: true,
        iteration: 1,
      },
      { type: "text", id: "t1", runId: "r1", agentId: "rlm", content: "The answer is 42" },
      { type: "harness_end", runId: "r1", agentId: "rlm", reason: "final" },
    ]);

    const data = projectRepl(g);
    const agent = data.agents[0]!;
    expect(agent.finalAnswer).toBe("The answer is 42");
    expect(agent.turns[0]!.output!.done).toBe(true);
  });

  test("error: repl_output with error field", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: "throw new Error('oops')",
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "",
        error: "Error: oops",
        done: false,
        iteration: 1,
      },
      { type: "harness_end", runId: "r1", agentId: "rlm" },
    ]);

    const data = projectRepl(g);
    const turn = data.agents[0]!.turns[0]!;
    expect(turn.phase).toBe("error");
    expect(turn.output!.error).toBe("Error: oops");
  });

  test("max iterations: harness_end reason=max_iterations", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm", maxIterations: 2 },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: "loop()",
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "...",
        done: false,
        iteration: 1,
      },
      {
        type: "harness_end",
        runId: "r1",
        agentId: "rlm",
        reason: "max_iterations",
        iterations: 2,
      },
    ]);

    const data = projectRepl(g);
    expect(data.agents[0]!.status).toBe("max_iterations");
  });

  test("recursive: parent spawns child via llm_query → child attached to parent turn", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: 'llm_query("sub-task")',
        iteration: 1,
      },
      // Child agent spawned from the repl_input block
      { type: "harness_start", runId: "r2", agentId: "rlm-child", parentId: "ri1", depth: 1 },
      {
        type: "repl_input",
        id: "ri2",
        runId: "r2",
        agentId: "rlm-child",
        parentId: "ri1",
        code: "1+1",
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri2",
        runId: "r2",
        agentId: "rlm-child",
        parentId: "ri1",
        stdout: "2",
        done: true,
        iteration: 1,
      },
      {
        type: "text",
        id: "t2",
        runId: "r2",
        agentId: "rlm-child",
        parentId: "ri1",
        content: "2",
      },
      { type: "harness_end", runId: "r2", agentId: "rlm-child", parentId: "ri1", reason: "final" },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "2",
        done: false,
        iteration: 1,
      },
      { type: "harness_end", runId: "r1", agentId: "rlm", reason: "final" },
    ]);

    const data = projectRepl(g);

    // Root agents should only contain the parent
    expect(data.agents.length).toBe(1);
    expect(data.agents[0]!.runId).toBe("r1");

    // All agents map should have both
    expect(data.allAgents.size).toBe(2);

    // Child agent details
    const child = data.allAgents.get("r2")!;
    expect(child.agentId).toBe("rlm-child");
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe("ri1");
    expect(child.turns.length).toBe(1);
    expect(child.finalAnswer).toBe("2");

    // Child is attached to parent's first turn
    const parentTurn = data.agents[0]!.turns[0]!;
    expect(parentTurn.childAgents.length).toBe(1);
    expect(parentTurn.childAgents[0]!.runId).toBe("r2");
  });

  test("streaming progress accumulates stdout and stderr", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: "process()",
        iteration: 1,
      },
      {
        type: "repl_progress",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        chunk: "out1",
        stream: "stdout",
      },
      {
        type: "repl_progress",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        chunk: "err1",
        stream: "stderr",
      },
      {
        type: "repl_progress",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        chunk: "out2",
        stream: "stdout",
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "out1out2",
        done: false,
        iteration: 1,
      },
      { type: "harness_end", runId: "r1", agentId: "rlm" },
    ]);

    const data = projectRepl(g);
    const turn = data.agents[0]!.turns[0]!;
    expect(turn.stdout).toBe("out1out2");
    expect(turn.stderr).toBe("err1");
  });

  test("harness-level error (e.g. invalid API key) creates a turn with errorMessage", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      {
        type: "error",
        runId: "r1",
        agentId: "rlm",
        message: "Zen API returned 401: Invalid API key.",
      },
      { type: "harness_end", runId: "r1", agentId: "rlm" },
    ]);

    const data = projectRepl(g);
    const agent = data.agents[0]!;
    expect(agent.status).toBe("error");
    expect(agent.turns.length).toBe(1);
    expect(agent.turns[0]!.phase).toBe("error");
    expect(agent.turns[0]!.errorMessage).toBe("Zen API returned 401: Invalid API key.");
  });

  test("extraction error creates separate turn — next turn's text is not merged", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      // Turn 1: text then extraction error (no repl_input/repl_output)
      { type: "text", id: "t1", runId: "r1", agentId: "rlm", content: "Let me try..." },
      {
        type: "error",
        runId: "r1",
        agentId: "rlm",
        message: "Response contained no code block.",
      },
      // Turn 2: model recovers with proper code
      { type: "text", id: "t2", runId: "r1", agentId: "rlm", content: "Sorry, here's the code:" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: 'FINAL("recovered")',
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "",
        done: true,
        iteration: 1,
      },
      { type: "text", id: "t3", runId: "r1", agentId: "rlm", content: "recovered" },
      { type: "harness_end", runId: "r1", agentId: "rlm", reason: "final" },
    ]);

    const data = projectRepl(g);
    const agent = data.agents[0]!;

    // Should be 2 separate turns, not merged
    expect(agent.turns.length).toBe(2);

    // Turn 1: error turn with reasoning
    expect(agent.turns[0]!.reasoning).toBe("Let me try...");
    expect(agent.turns[0]!.errorMessage).toBe("Response contained no code block.");
    expect(agent.turns[0]!.phase).toBe("error");
    expect(agent.turns[0]!.code).toBeNull();

    // Turn 2: recovery turn
    expect(agent.turns[1]!.reasoning).toBe("Sorry, here's the code:");
    expect(agent.turns[1]!.code).toBe('FINAL("recovered")');
  });

  test("empty graph returns empty data", () => {
    const g = createGraph();
    const data = projectRepl(g);
    expect(data.agents.length).toBe(0);
    expect(data.allAgents.size).toBe(0);
  });

  test("totalUsage from harness_end is captured", () => {
    const g = buildGraph([
      { type: "harness_start", runId: "r1", agentId: "rlm" },
      {
        type: "repl_input",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        code: "1",
        iteration: 1,
      },
      {
        type: "repl_output",
        id: "ri1",
        runId: "r1",
        agentId: "rlm",
        stdout: "1",
        done: true,
        iteration: 1,
      },
      {
        type: "harness_end",
        runId: "r1",
        agentId: "rlm",
        reason: "final",
        totalUsage: { inputTokens: 1000, outputTokens: 500 },
      },
    ]);

    const data = projectRepl(g);
    expect(data.agents[0]!.totalUsage).toEqual({ inputTokens: 1000, outputTokens: 500 });
  });
});
