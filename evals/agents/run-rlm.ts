/**
 * Bun runner script for the RLM harness inside a Harbor container.
 *
 * Usage:
 *   bun run evals/agents/run-rlm.ts <instruction> [--model <model>] [--max-iterations <n>]
 *
 * Imports the RLM harness, runs it with the given instruction as context,
 * collects events until harness_end, and writes the final text output to
 * /tmp/rlm-result.txt.
 *
 * When EVAL_EVENT_PORT is set, events are POSTed back to the host's eval TUI
 * over HTTP so the ReplView can render live agent progress.
 */

import { createRlmHarness } from "../../packages/ai/rlm/harness.ts";
import { createGeneratorHarness } from "../../packages/ai/harness/providers/zen.ts";
import type { HarnessEvent } from "../../packages/ai/types.ts";

const RESULT_PATH = "/tmp/rlm-result.txt";
const METRICS_PATH = "/tmp/rlm-metrics.json";
const DIAGNOSTICS_PATH = "/tmp/rlm-diagnostics.json";

const EVENT_PORT = process.env.EVAL_EVENT_PORT;
const RELAY_HOST_CANDIDATES = ["host.docker.internal", "host.containers.internal", "172.17.0.1"];
const EVENT_URLS = EVENT_PORT
  ? RELAY_HOST_CANDIDATES.map((host) => `http://${host}:${EVENT_PORT}/event`)
  : [];
let relayFailureLogged = false;
let relayUrlIndex = 0;

/**
 * Convert a HarnessEvent to a JSON-serializable ServerEvent-compatible object.
 * Adds agentId (required by the client-side graph reducer) and converts
 * non-serializable fields (Error objects, respond callbacks).
 */
function serializeEvent(event: HarnessEvent): string {
  const base = { agentId: "rlm" };
  if (event.type === "error") {
    const { error, ...rest } = event;
    return JSON.stringify({ ...base, ...rest, message: error.message });
  }
  if (event.type === "relay") {
    const { respond, ...rest } = event;
    return JSON.stringify({ ...base, ...rest });
  }
  return JSON.stringify({ ...base, ...event });
}

/** POST event to the eval TUI's event server, awaited for ordering. */
async function emitEvent(event: HarnessEvent): Promise<void> {
  if (EVENT_URLS.length === 0) return;

  const payload = serializeEvent(event);
  for (let attempt = 0; attempt < EVENT_URLS.length; attempt++) {
    const idx = (relayUrlIndex + attempt) % EVENT_URLS.length;
    const eventUrl = EVENT_URLS[idx]!;
    try {
      const response = await fetch(eventUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (response.ok) {
        relayUrlIndex = idx;
        return;
      }
    } catch {}
  }
  if (!relayFailureLogged) {
    relayFailureLogged = true;
    console.error("[run-rlm] event relay failed: all URL candidates exhausted");
  }
}

function parseArgs(argv: string[]): {
  instruction: string;
  model: string;
  maxIterations: number;
  depth: number;
  cwd: string | undefined;
} {
  // argv: [bun, script, instruction, ...flags]
  const args = argv.slice(2);
  let instruction = "";
  let model = "claude-sonnet-4-6";
  let maxIterations = 1000;
  let depth = 4;
  let cwd: string | undefined;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--model" && i + 1 < args.length) {
      model = args[i + 1]!;
      i += 2;
    } else if (args[i] === "--max-iterations" && i + 1 < args.length) {
      maxIterations = parseInt(args[i + 1]!, 10);
      i += 2;
    } else if (args[i] === "--depth" && i + 1 < args.length) {
      depth = parseInt(args[i + 1]!, 10);
      i += 2;
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[i + 1]!;
      i += 2;
    } else if (!instruction) {
      instruction = args[i]!;
      i += 1;
    } else {
      i += 1;
    }
  }

  if (!instruction) {
    console.error(
      "Usage: bun run run-rlm.ts <instruction> [--model <model>] [--max-iterations <n>] [--depth <n>] [--cwd <dir>]",
    );
    process.exit(1);
  }

  return { instruction, model, maxIterations, depth, cwd };
}

/** Diagnostics: periodic memory/state snapshots written to disk so we have data after a crash. */
interface DiagSnapshot {
  iteration: number;
  timestamp: string;
  rssKB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  eventCount: number;
  messageHistorySize: number;
  lastEventType: string;
}

const diagnostics: DiagSnapshot[] = [];
let diagEventCount = 0;
let diagLastEventType = "";

function takeDiagSnapshot(iteration: number, messageHistorySize: number): DiagSnapshot {
  // Bun.gc returns heap stats when called with true
  if (typeof Bun.gc === "function") Bun.gc(false);

  const mem = process.memoryUsage();
  const snap: DiagSnapshot = {
    iteration,
    timestamp: new Date().toISOString(),
    rssKB: Math.round(mem.rss / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    eventCount: diagEventCount,
    messageHistorySize,
    lastEventType: diagLastEventType,
  };
  diagnostics.push(snap);
  return snap;
}

/** Flush diagnostics to disk — called periodically and on crash signal. */
async function flushDiagnostics() {
  try {
    await Bun.write(DIAGNOSTICS_PATH, JSON.stringify({ pid: process.pid, bun: Bun.version, snapshots: diagnostics }, null, 2));
  } catch {}
}

/** Register signal handlers to capture state before crash death. */
function registerCrashHandlers() {
  const handler = async (signal: string) => {
    console.error(`[run-rlm] received ${signal} — flushing diagnostics`);
    await flushDiagnostics();
    process.exit(128);
  };
  // SIGSEGV can't be caught, but SIGABRT/SIGBUS/SIGTERM can
  for (const sig of ["SIGABRT", "SIGBUS", "SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => handler(sig));
  }
  process.on("uncaughtException", async (err) => {
    console.error(`[run-rlm] uncaughtException: ${err.message}`);
    diagnostics.push({ iteration: -1, timestamp: new Date().toISOString(), rssKB: 0, heapUsedMB: 0, heapTotalMB: 0, eventCount: diagEventCount, messageHistorySize: 0, lastEventType: `CRASH:${err.message}` });
    await flushDiagnostics();
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[run-rlm] unhandledRejection: ${msg}`);
    diagnostics.push({ iteration: -1, timestamp: new Date().toISOString(), rssKB: 0, heapUsedMB: 0, heapTotalMB: 0, eventCount: diagEventCount, messageHistorySize: 0, lastEventType: `REJECTION:${msg}` });
    await flushDiagnostics();
  });
}

async function main() {
  const { instruction, model, maxIterations, depth, cwd } = parseArgs(process.argv);

  if (cwd) process.chdir(cwd);

  registerCrashHandlers();

  console.error(`[run-rlm] pid=${process.pid} bun=${Bun.version} rss=${Math.round(process.memoryUsage().rss / 1024)}KB`);

  if (EVENT_URLS.length > 0) {
    console.error(`[run-rlm] event relay candidates: ${EVENT_URLS.join(", ")}`);
  }

  const provider = createGeneratorHarness();
  const rlm = createRlmHarness({
    rootHarness: provider,
    config: {
      maxIterations,
      maxDepth: depth,
      maxStdoutLength: 4000,
      metadataPrefixLength: 200,
      ...(cwd && { execCwd: cwd }),
    },
  });

  // Emit the user prompt so the eval TUI can display it in the REPL view
  await emitEvent({ type: "user_prompt", content: instruction } as unknown as HarnessEvent);

  let finalText = "";
  let collecting = false;
  let rootRunId: string | undefined;
  let currentIteration = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const usageSteps: Array<{
    iteration: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = [];

  // Take initial snapshot
  takeDiagSnapshot(0, 0);

  for await (const event of rlm.invoke({
    model,
    messages: [{ role: "user", content: instruction }],
    context: instruction,
  })) {
    diagEventCount++;
    diagLastEventType = event.type;

    // Track root harness runId from the first harness_start
    if (event.type === "harness_start" && !rootRunId) {
      rootRunId = event.runId;
    }

    // Relay event to eval TUI — awaited to preserve ordering for spawn edges
    await emitEvent(event);

    // Track result collection: repl_output with done=true signals that
    // the next text event(s) contain the final answer.
    if (event.type === "repl_output" && event.done) {
      collecting = true;
    }
    if (event.type === "text" && collecting) {
      finalText += event.content;
    }

    // Accumulate token usage across all iterations
    if (event.type === "usage") {
      usage.inputTokens += event.inputTokens;
      usage.outputTokens += event.outputTokens;
      usage.cacheReadTokens += event.cacheReadTokens ?? 0;
      usage.cacheCreationTokens += event.cacheCreationTokens ?? 0;
      usageSteps.push({
        iteration: currentIteration,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheCreationTokens: event.cacheCreationTokens ?? 0,
      });
    }

    // Human-readable stderr logs + diagnostics
    if (event.type === "error") {
      console.error(`[rlm error] ${event.error}`);
    }
    if (event.type === "repl_output" && event.error) {
      console.error(`[repl error] iteration ${event.iteration}: ${event.error}`);
    }
    if (event.type === "repl_input") {
      currentIteration = event.iteration ?? currentIteration;
      console.error(`[iteration ${event.iteration}] executing code (${event.code.length} chars)`);
    }

    // Snapshot every 5 iterations on repl_output (after exec completes)
    if (event.type === "repl_output" && currentIteration % 5 === 0) {
      const snap = takeDiagSnapshot(currentIteration, 0);
      console.error(`[diag] iter=${snap.iteration} rss=${snap.rssKB}KB heap=${snap.heapUsedMB}/${snap.heapTotalMB}MB events=${snap.eventCount}`);
      // Flush to disk every snapshot so we have data after crash
      await flushDiagnostics();
    }

    // Only break on the root harness's end — child harness_end events flow through
    if (event.type === "harness_end" && event.runId === rootRunId) {
      console.error(`[harness_end] reason=${event.reason} iterations=${event.iterations}`);
      break;
    }
  }

  // Final snapshot
  takeDiagSnapshot(currentIteration, 0);
  await flushDiagnostics();

  await Bun.write(RESULT_PATH, finalText);
  await Bun.write(METRICS_PATH, JSON.stringify({ ...usage, steps: usageSteps }));
  console.log(`Result written to ${RESULT_PATH} (${finalText.length} chars)`);
  console.log(`Metrics: input=${usage.inputTokens} output=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} cacheCreation=${usage.cacheCreationTokens}`);
}

main().catch((err) => {
  console.error("run-rlm failed:", err);
  process.exit(1);
});
