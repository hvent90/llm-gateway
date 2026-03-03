/**
 * Event stream generators for performance benchmarks.
 *
 * Produces realistic eval sessions matching the pattern:
 *   harness_start, [text, repl_input, (repl_progress * M), repl_output] * N, harness_end
 *
 * Parameterizable by (turns, progressChunksPerTurn, numRuns).
 */
import type { ServerEvent } from "../../../server-event";

export interface GeneratorParams {
  /** Number of REPL turns per run */
  turns: number;
  /** Number of repl_progress events per turn */
  progressChunksPerTurn: number;
  /** Number of independent agent runs (for multi-run scenarios) */
  numRuns: number;
}

const DEFAULTS: GeneratorParams = {
  turns: 10,
  progressChunksPerTurn: 50,
  numRuns: 1,
};

/**
 * Generate a flat array of events for a single agent run.
 */
function generateRunEvents(
  runId: string,
  agentId: string,
  params: GeneratorParams,
  parentId?: string,
): ServerEvent[] {
  const events: ServerEvent[] = [];

  // harness_start
  events.push({
    type: "harness_start",
    runId,
    agentId,
    ...(parentId ? { parentId } : {}),
    depth: parentId ? 1 : 0,
    maxIterations: params.turns,
  } as ServerEvent);

  for (let t = 0; t < params.turns; t++) {
    const turnId = `${runId}:turn${t}`;

    // text (reasoning)
    events.push({
      type: "text",
      id: `${turnId}:text`,
      runId,
      agentId,
      content: `Reasoning for turn ${t}...`,
    } as ServerEvent);

    // repl_input
    events.push({
      type: "repl_input",
      id: turnId,
      runId,
      agentId,
      code: `console.log("turn ${t}")`,
      iteration: t + 1,
    } as ServerEvent);

    // repl_progress * M
    for (let p = 0; p < params.progressChunksPerTurn; p++) {
      events.push({
        type: "repl_progress",
        id: turnId,
        runId,
        agentId,
        chunk: `output chunk ${p}\n`,
        stream: "stdout",
      } as ServerEvent);
    }

    // repl_output
    events.push({
      type: "repl_output",
      id: turnId,
      runId,
      agentId,
      stdout: `turn ${t} done\n`,
      done: t === params.turns - 1,
      iteration: t + 1,
      durationMs: 100,
    } as ServerEvent);
  }

  // harness_end
  events.push({
    type: "harness_end",
    runId,
    agentId,
    reason: "final",
    iterations: params.turns,
    totalUsage: { inputTokens: params.turns * 1000, outputTokens: params.turns * 500 },
  } as ServerEvent);

  return events;
}

/**
 * Generate a complete eval session event stream.
 *
 * For numRuns=1, produces a single agent's events.
 * For numRuns>1, produces a root agent that spawns child agents
 * (interleaved to simulate realistic concurrent execution).
 */
export function generateEvalSession(userParams?: Partial<GeneratorParams>): ServerEvent[] {
  const params = { ...DEFAULTS, ...userParams };

  if (params.numRuns === 1) {
    return generateRunEvents("run-0", "rlm-0", params);
  }

  // Multi-run: root agent spawns children
  const rootRunId = "run-root";
  const rootAgentId = "rlm-root";
  const events: ServerEvent[] = [];

  events.push({
    type: "harness_start",
    runId: rootRunId,
    agentId: rootAgentId,
    depth: 0,
    maxIterations: params.numRuns,
  } as ServerEvent);

  // Root agent emits a tool_call for each child, then child runs
  for (let r = 0; r < params.numRuns; r++) {
    const childRunId = `run-${r}`;
    const childAgentId = `rlm-${r}`;
    const toolCallId = `${rootRunId}:spawn${r}`;

    // Root agent emits text + tool_call to spawn child
    events.push({
      type: "text",
      id: `${rootRunId}:spawn-text-${r}`,
      runId: rootRunId,
      agentId: rootAgentId,
      content: `Spawning agent ${r}...`,
    } as ServerEvent);

    events.push({
      type: "tool_call",
      id: toolCallId,
      runId: rootRunId,
      agentId: rootAgentId,
      name: "spawn_agent",
      input: { task: `task-${r}` },
    } as ServerEvent);

    // Child agent events (parentId points to tool_call)
    const childEvents = generateRunEvents(childRunId, childAgentId, params, toolCallId);
    events.push(...childEvents);

    // Tool result back on root
    events.push({
      type: "tool_result",
      id: toolCallId,
      runId: rootRunId,
      agentId: rootAgentId,
      name: "spawn_agent",
      output: { status: "done" },
    } as ServerEvent);
  }

  events.push({
    type: "harness_end",
    runId: rootRunId,
    agentId: rootAgentId,
    reason: "final",
    iterations: params.numRuns,
  } as ServerEvent);

  return events;
}

/**
 * Calculate the total number of events for given params (useful for assertions).
 */
export function expectedEventCount(userParams?: Partial<GeneratorParams>): number {
  const params = { ...DEFAULTS, ...userParams };
  // Per run: harness_start + (text + repl_input + M * repl_progress + repl_output) * N + harness_end
  const perRun = 1 + params.turns * (2 + params.progressChunksPerTurn + 1) + 1;

  if (params.numRuns === 1) return perRun;

  // Multi-run: root harness_start + (text + tool_call + child_events + tool_result) * R + harness_end
  return 1 + params.numRuns * (2 + perRun + 1) + 1;
}
