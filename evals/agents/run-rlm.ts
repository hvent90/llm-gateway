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

/** Fire-and-forget POST to the eval TUI's event server. */
function emitEvent(event: HarnessEvent) {
  if (EVENT_URLS.length === 0) return;

  const payload = serializeEvent(event);
  const trySend = (index: number) => {
    const eventUrl = EVENT_URLS[index];
    if (!eventUrl) return;
    fetch(eventUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
      .then((response) => {
        if (!response.ok) {
          if (index + 1 < EVENT_URLS.length) {
            relayUrlIndex = index + 1;
            trySend(relayUrlIndex);
            return;
          }
          if (!relayFailureLogged) {
            relayFailureLogged = true;
            console.error(
              `[run-rlm] event relay failed (${eventUrl}): HTTP ${response.status} ${response.statusText}`,
            );
          }
          return;
        }
        relayUrlIndex = index;
      })
      .catch((error) => {
        if (index + 1 < EVENT_URLS.length) {
          relayUrlIndex = index + 1;
          trySend(relayUrlIndex);
          return;
        }
        if (!relayFailureLogged) {
          relayFailureLogged = true;
          console.error(`[run-rlm] event relay failed (${eventUrl}): ${String(error)}`);
        }
      });
  };

  trySend(relayUrlIndex);
}

function parseArgs(argv: string[]): {
  instruction: string;
  model: string;
  maxIterations: number;
} {
  // argv: [bun, script, instruction, ...flags]
  const args = argv.slice(2);
  let instruction = "";
  let model = "claude-sonnet-4-6";
  let maxIterations = 10;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--model" && i + 1 < args.length) {
      model = args[i + 1]!;
      i += 2;
    } else if (args[i] === "--max-iterations" && i + 1 < args.length) {
      maxIterations = parseInt(args[i + 1]!, 10);
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
      "Usage: bun run run-rlm.ts <instruction> [--model <model>] [--max-iterations <n>]",
    );
    process.exit(1);
  }

  return { instruction, model, maxIterations };
}

async function main() {
  const { instruction, model, maxIterations } = parseArgs(process.argv);

  if (EVENT_URLS.length > 0) {
    console.error(`[run-rlm] event relay candidates: ${EVENT_URLS.join(", ")}`);
  }

  const provider = createGeneratorHarness();
  const rlm = createRlmHarness({
    rootHarness: provider,
    config: {
      maxIterations,
      maxStdoutLength: 4000,
      metadataPrefixLength: 200,
    },
  });

  let finalText = "";
  let collecting = false;

  for await (const event of rlm.invoke({
    model,
    messages: [{ role: "user", content: instruction }],
    context: instruction,
  })) {
    // Relay event to eval TUI over HTTP
    emitEvent(event);

    // Track result collection: repl_output with done=true signals that
    // the next text event(s) contain the final answer.
    if (event.type === "repl_output" && event.done) {
      collecting = true;
    }
    if (event.type === "text" && collecting) {
      finalText += event.content;
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
    if (event.type === "harness_end") {
      console.error(`[harness_end] reason=${event.reason} iterations=${event.iterations}`);
      break;
    }
  }

  await Bun.write(RESULT_PATH, finalText);
  console.log(`Result written to ${RESULT_PATH} (${finalText.length} chars)`);
}

main().catch((err) => {
  console.error("run-rlm failed:", err);
  process.exit(1);
});
