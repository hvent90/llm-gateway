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
import { createGeneratorHarness } from "../../packages/ai/harness/providers/claude-code.ts";
import type { HarnessEvent } from "../../packages/ai/types.ts";

const RESULT_PATH = "/tmp/rlm-result.txt";
const METRICS_PATH = "/tmp/rlm-metrics.json";

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
  const agentId = "rlm";
  if (event.type === "error") {
    const { error, ...rest } = event;
    return JSON.stringify({ ...rest, agentId, message: error.message });
  }
  if (event.type === "relay") {
    const { respond, ...rest } = event;
    return JSON.stringify({ ...rest, agentId });
  }
  return JSON.stringify({ ...event, agentId });
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
} {
  // argv: [bun, script, instruction, ...flags]
  const args = argv.slice(2);
  let instruction = "";
  let model = "claude-sonnet-4-6";
  let maxIterations = 1000;
  let depth = 4;

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
    } else if (!instruction) {
      instruction = args[i]!;
      i += 1;
    } else {
      i += 1;
    }
  }

  if (!instruction) {
    console.error(
      "Usage: bun run run-rlm.ts <instruction> [--model <model>] [--max-iterations <n>] [--depth <n>]",
    );
    process.exit(1);
  }

  return { instruction, model, maxIterations, depth };
}

async function main() {
  const { instruction, model, maxIterations, depth } = parseArgs(process.argv);

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
    },
  });

  // Emit the user prompt so the eval TUI can display it in the REPL view
  await emitEvent({ type: "user_prompt", content: instruction } as unknown as HarnessEvent);

  let finalText = "";
  let collecting = false;
  let rootRunId: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  for await (const event of rlm.invoke({
    model,
    messages: [{ role: "user", content: instruction }],
    context: instruction,
  })) {
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
    }

    // Human-readable stderr logs
    if (event.type === "error") {
      console.error(`[rlm error] ${event.error}`);
    }
    if (event.type === "repl_output" && event.error) {
      console.error(`[repl error] iteration ${event.iteration}: ${event.error}`);
    }
    if (event.type === "repl_input") {
      console.error(`[iteration ${event.iteration}] executing code (${event.code.length} chars)`);
    }
    // Only break on the root harness's end — child harness_end events flow through
    if (event.type === "harness_end" && event.runId === rootRunId) {
      console.error(`[harness_end] reason=${event.reason} iterations=${event.iterations}`);
      break;
    }
  }

  await Bun.write(RESULT_PATH, finalText);
  await Bun.write(METRICS_PATH, JSON.stringify(usage));
  console.log(`Result written to ${RESULT_PATH} (${finalText.length} chars)`);
  console.log(`Metrics: input=${usage.inputTokens} output=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} cacheCreation=${usage.cacheCreationTokens}`);
}

main().catch((err) => {
  console.error("run-rlm failed:", err);
  process.exit(1);
});
