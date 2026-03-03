/**
 * Timing harness for measuring per-event processing cost.
 *
 * Measures the cost of reduceEvent and reduceConversation at different
 * points in a stream to detect O(N) or O(N^2) scaling patterns.
 */
import type { ServerEvent } from "../../../server-event";
import type { ConversationGraph } from "../../types";
import { createGraph } from "../../primitives";
import { reduceEvent, createReducerState, type ReducerState } from "../../reducer";
import {
  reduceConversation,
  createInitialConversation,
  type ConversationState,
  type ConversationEvent,
} from "../../conversation";
import { projectRepl, type ReplData } from "../../projections/repl";
import { flattenAgents } from "../../../../../../packages/ui/cli/repl/sidebar";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimingBucket {
  /** Descriptive label for this bucket (e.g., "first 10%", "last 10%") */
  label: string;
  /** Event indices in this bucket */
  startIndex: number;
  endIndex: number;
  /** Per-event times in microseconds */
  times: number[];
  /** Computed stats */
  mean: number;
  median: number;
  p99: number;
  max: number;
}

export interface TimingResult {
  /** Total events processed */
  totalEvents: number;
  /** Total wall time in milliseconds */
  totalTimeMs: number;
  /** Buckets for analysis */
  buckets: TimingBucket[];
  /** All per-event times in microseconds (for custom analysis) */
  allTimes: number[];
}

// ---------------------------------------------------------------------------
// Timing functions
// ---------------------------------------------------------------------------

function computeStats(times: number[]): { mean: number; median: number; p99: number; max: number } {
  if (times.length === 0) return { mean: 0, median: 0, p99: 0, max: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
  const max = sorted[sorted.length - 1]!;
  return { mean, median, p99, max };
}

function makeBucket(
  label: string,
  startIndex: number,
  endIndex: number,
  allTimes: number[],
): TimingBucket {
  const times = allTimes.slice(startIndex, endIndex);
  return { label, startIndex, endIndex, times, ...computeStats(times) };
}

/**
 * Measure per-event cost of reduceEvent (graph-level only, no defaultActive).
 */
export function benchReduceEvent(events: ServerEvent[]): TimingResult {
  let graph: ConversationGraph = createGraph();
  let state: ReducerState = createReducerState();
  const allTimes: number[] = [];

  const totalStart = performance.now();

  for (const event of events) {
    const start = performance.now();
    [graph, state] = reduceEvent(graph, state, event as any);
    const elapsed = (performance.now() - start) * 1000; // microseconds
    allTimes.push(elapsed);
  }

  const totalTimeMs = performance.now() - totalStart;
  const len = allTimes.length;
  const tenPct = Math.max(1, Math.floor(len * 0.1));

  return {
    totalEvents: len,
    totalTimeMs,
    allTimes,
    buckets: [
      makeBucket("first 10%", 0, tenPct, allTimes),
      makeBucket("middle 80%", tenPct, len - tenPct, allTimes),
      makeBucket("last 10%", len - tenPct, len, allTimes),
    ],
  };
}

/**
 * Measure per-event cost of reduceConversation (includes defaultActive).
 */
export function benchReduceConversation(events: ServerEvent[]): TimingResult {
  let state: ConversationState = createInitialConversation();
  const allTimes: number[] = [];

  const totalStart = performance.now();

  for (const event of events) {
    const start = performance.now();
    state = reduceConversation(state, event as ConversationEvent);
    const elapsed = (performance.now() - start) * 1000;
    allTimes.push(elapsed);
  }

  const totalTimeMs = performance.now() - totalStart;
  const len = allTimes.length;
  const tenPct = Math.max(1, Math.floor(len * 0.1));

  return {
    totalEvents: len,
    totalTimeMs,
    allTimes,
    buckets: [
      makeBucket("first 10%", 0, tenPct, allTimes),
      makeBucket("middle 80%", tenPct, len - tenPct, allTimes),
      makeBucket("last 10%", len - tenPct, len, allTimes),
    ],
  };
}

/**
 * Measure the cost of projectRepl on the final graph after processing all events.
 */
export function benchProjectRepl(
  events: ServerEvent[],
  numCalls: number = 100,
): {
  graph: ConversationGraph;
  times: number[];
  mean: number;
  median: number;
  p99: number;
  data: ReplData;
} {
  // Build the graph first
  let graph: ConversationGraph = createGraph();
  let state: ReducerState = createReducerState();
  for (const event of events) {
    [graph, state] = reduceEvent(graph, state, event as any);
  }

  // Measure projectRepl calls
  const times: number[] = [];
  let data: ReplData = { agents: [], allAgents: new Map() };
  for (let i = 0; i < numCalls; i++) {
    const start = performance.now();
    data = projectRepl(graph);
    times.push((performance.now() - start) * 1000);
  }

  return { graph, times, ...computeStats(times), data };
}

/**
 * Measure the full pipeline: reduce -> project -> flatten per event.
 * This simulates the actual eval CLI hot path.
 */
export function benchFullPipeline(events: ServerEvent[]): TimingResult {
  let convState: ConversationState = createInitialConversation();
  const allTimes: number[] = [];

  const totalStart = performance.now();

  for (const event of events) {
    const start = performance.now();
    convState = reduceConversation(convState, event as ConversationEvent);
    const replData = projectRepl(convState.graph);
    flattenAgents(replData.agents);
    const elapsed = (performance.now() - start) * 1000;
    allTimes.push(elapsed);
  }

  const totalTimeMs = performance.now() - totalStart;
  const len = allTimes.length;
  const tenPct = Math.max(1, Math.floor(len * 0.1));

  return {
    totalEvents: len,
    totalTimeMs,
    allTimes,
    buckets: [
      makeBucket("first 10%", 0, tenPct, allTimes),
      makeBucket("middle 80%", tenPct, len - tenPct, allTimes),
      makeBucket("last 10%", len - tenPct, len, allTimes),
    ],
  };
}

/**
 * Helper: format a TimingResult for readable output.
 */
export function formatResult(label: string, result: TimingResult): string {
  const lines = [
    `\n=== ${label} ===`,
    `Total: ${result.totalEvents} events in ${result.totalTimeMs.toFixed(1)}ms`,
    `Avg: ${((result.totalTimeMs / result.totalEvents) * 1000).toFixed(0)}us/event`,
  ];
  for (const bucket of result.buckets) {
    lines.push(
      `  ${bucket.label}: mean=${bucket.mean.toFixed(0)}us median=${bucket.median.toFixed(0)}us p99=${bucket.p99.toFixed(0)}us max=${bucket.max.toFixed(0)}us`,
    );
  }
  return lines.join("\n");
}
