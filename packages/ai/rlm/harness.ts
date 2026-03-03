import { v7 as uuidv7 } from "uuid";
import type {
  GeneratorHarnessModule,
  GeneratorInvokeParams,
  HarnessEvent,
  Message,
  PermissionResponse,
  RelayEvent,
} from "../types";
import type { RlmConfig, ReplExecutionResult } from "./types";
import { createRepl } from "./repl";
import { buildRlmSystemPrompt } from "./system-prompt";
import { spawn } from "bun";
import { AsyncQueue } from "../primitives/async-queue";
import { deferred } from "../primitives";
import { matchesPermissions } from "../permissions";

interface RlmHarnessOptions {
  /** Provider harness for root LLM calls */
  rootHarness: GeneratorHarnessModule;
  /** Provider harness for sub LLM calls (llm_query in REPL). Defaults to rootHarness. */
  subHarness?: GeneratorHarnessModule;
  /** RLM configuration */
  config: RlmConfig;
  /** Internal: current recursion depth (set by child RLM spawning) */
  _depth?: number;
}

/** Extract code from a model response. Looks for fenced JS blocks, concatenates if multiple. */
function extractCode(text: string): string {
  const fenceRe = /```(?:js|javascript)\n([\s\S]*?)```/g;
  const matches = [...text.matchAll(fenceRe)];
  if (matches.length >= 1) return matches.map((m) => m[1].trim()).join("\n");
  throw new Error("Response contained no code block. Expected exactly one ```js block per turn.");
}

/** Collect all text from a provider harness invocation. */
async function collectText(
  iterable: AsyncIterable<HarnessEvent>,
): Promise<{ text: string; events: HarnessEvent[] }> {
  let text = "";
  const events: HarnessEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (event.type === "text") text += event.content;
  }
  return { text, events };
}

function createRlmHarness(options: RlmHarnessOptions): GeneratorHarnessModule {
  const { rootHarness, config } = options;
  const subHarness = options.subHarness ?? rootHarness;

  return {
    async *invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent> {
      const runId = uuidv7();
      const parentId = params.env?.parentId;

      const tag = <T extends { runId: string }>(event: T): T & { parentId?: string } => {
        const tagged = { ...event, runId };
        if (parentId) (tagged as T & { parentId?: string }).parentId = parentId;
        else delete (tagged as T & { parentId?: string }).parentId;
        return tagged;
      };

      const currentDepth = options._depth ?? 0;
      yield tag({
        type: "harness_start",
        runId,
        ...(currentDepth > 0 ? { depth: currentDepth } : {}),
        maxIterations: config.maxIterations,
      });

      // Aggregate usage tracking
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let iterationsRan = 0;
      let completionReason: "final" | "max_iterations" = "max_iterations";

      // The context string is the data for the REPL to work with
      const ctx = params.context ?? "";

      // llm_query callback: depth-aware. At depth > 0, spawns a child RLM session.
      // At depth 0, falls back to a flat one-shot call.
      const depth = config.maxDepth ?? 2;
      const llmQuery = async (prompt: string, context?: string): Promise<string> => {
        const promptBudget = config.subPromptBudget ?? 10_000;
        const ctx = context ?? "";
        if (prompt.length > promptBudget) {
          throw new Error(
            `llm_query prompt exceeds ${promptBudget} char limit (got ${prompt.length}). Keep instructions short — pass data as the second argument (context).`,
          );
        }
        execEvents?.push({
          type: "progress",
          event: tag({
            type: "repl_progress" as const,
            runId,
            id: uuidv7(),
            chunk: `[llm_query] prompt=${prompt.length} context=${ctx.length} depth=${depth}\n`,
            stream: "stderr" as const,
          }),
        });

        if (depth > 0) {
          // Recursive: spawn a child RLM session with its own REPL
          const childRlm = createRlmHarness({
            rootHarness: subHarness,
            config: { ...config, maxDepth: depth - 1 },
            _depth: currentDepth + 1,
          });
          let text = "";
          let collecting = false;
          for await (const childEvent of childRlm.invoke({
            model: config.subModel ?? params.model,
            context: ctx,
            messages: [{ role: "user", content: prompt }],
            env: { parentId: currentCallId! },
          })) {
            // Forward child events as progress
            execEvents?.push({ type: "progress", event: childEvent });
            // Only collect FINAL answer text (after repl_output with done=true)
            if (childEvent.type === "repl_output" && childEvent.done) collecting = true;
            else if (childEvent.type === "text" && collecting) text += childEvent.content;
          }
          execEvents?.push({
            type: "progress",
            event: tag({
              type: "repl_progress" as const,
              runId,
              id: uuidv7(),
              chunk: `[llm_query] done result=${text.length} chars\n`,
              stream: "stderr" as const,
            }),
          });
          return text;
        }

        // Flat: one-shot LLM call (base case)
        const message = ctx ? `${prompt}\n\n${ctx}` : prompt;
        const { text, events: flatEvents } = await collectText(
          subHarness.invoke({
            model: config.subModel ?? params.model,
            messages: [{ role: "user", content: message }],
          }),
        );
        // Gap #7 — Forward flat call usage events
        for (const e of flatEvents) {
          if (e.type === "usage") {
            execEvents?.push({ type: "progress", event: tag(e) });
            totalInputTokens += e.inputTokens;
            totalOutputTokens += e.outputTokens;
          }
        }
        execEvents?.push({
          type: "progress",
          event: tag({
            type: "repl_progress" as const,
            runId,
            id: uuidv7(),
            chunk: `[llm_query] done result=${text.length} chars\n`,
            stream: "stderr" as const,
          }),
        });
        return text;
      };

      // Queue for events that need to be yielded from the generator during REPL execution
      type ExecQueueItem =
        | { type: "relay"; event: RelayEvent }
        | { type: "progress"; event: HarnessEvent }
        | { type: "repl_done"; result: ReplExecutionResult };

      let execEvents: AsyncQueue<ExecQueueItem> | undefined;
      let currentCallId: string | undefined;

      // exec callback: run a shell command with permission check and streaming
      const exec = async (command: string, timeout?: number) => {
        // Permission check (unchanged)
        if (params.permissions) {
          const isAllowed = matchesPermissions(
            { name: "exec", arguments: { command } },
            params.permissions,
          );

          if (!isAllowed) {
            const d = deferred<PermissionResponse>();
            const relayEvent: RelayEvent = tag({
              type: "relay" as const,
              kind: "permission" as const,
              runId,
              id: uuidv7(),
              toolCallId: uuidv7(),
              tool: "exec",
              params: { command },
              respond: (response: PermissionResponse) => d.resolve(response),
            });

            execEvents?.push({ type: "relay", event: relayEvent });

            const decision = await d.promise;
            if (!decision.approved) {
              throw new Error(`exec denied: ${decision.reason ?? "permission denied"}`);
            }
          }
        }

        // Spawn process with access to live streams
        const effectiveTimeout = timeout ?? config.execTimeout ?? 10;
        const proc = spawn({
          cmd: ["sh", "-c", command],
          cwd: config.execCwd,
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });

        const startTime = Date.now();

        // Drain a readable stream, collecting into buffer and pushing repl_progress events
        const drainStream = async (
          stream: ReadableStream<Uint8Array>,
          channel: "stdout" | "stderr",
        ): Promise<string> => {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          const chunks: string[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              chunks.push(text);
              execEvents?.push({
                type: "progress",
                event: tag({
                  type: "repl_progress" as const,
                  runId,
                  id: uuidv7(),
                  chunk: text,
                  stream: channel,
                }),
              });
            }
          } catch {
            // Stream cancelled — return what we have
          }
          return chunks.join("");
        };

        // Poll process metrics every 1s, aggregating the process tree
        let metricsRunning = true;
        const pollMetrics = async () => {
          while (metricsRunning) {
            await Bun.sleep(1000);
            if (!metricsRunning) break;
            try {
              // Find child PIDs so we can aggregate the whole process tree
              const findChildren = spawn({
                cmd: ["sh", "-c", `ps -eo pid,ppid | awk '$2 == ${proc.pid} {printf "%s,", $1}'`],
                stdout: "pipe",
                stderr: "pipe",
              });
              const childPidsRaw = await new Response(findChildren.stdout).text();
              await findChildren.exited;

              const allPids = [String(proc.pid)];
              for (const p of childPidsRaw.split(",")) {
                if (p.trim()) allPids.push(p.trim());
              }

              const ps = spawn({
                cmd: ["ps", "-p", allPids.join(","), "-o", "%cpu,rss"],
                stdout: "pipe",
                stderr: "pipe",
              });
              const output = await new Response(ps.stdout).text();
              await ps.exited;
              const lines = output.trim().split("\n");
              // Sum CPU and RSS across all processes in the tree
              let totalCpu = 0;
              let totalRss = 0;
              for (let i = 1; i < lines.length; i++) {
                const [cpu, rss] = lines[i].trim().split(/\s+/);
                totalCpu += parseFloat(cpu);
                totalRss += parseInt(rss, 10);
              }
              if (lines.length >= 2) {
                execEvents?.push({
                  type: "progress",
                  event: tag({
                    type: "repl_progress" as const,
                    runId,
                    id: uuidv7(),
                    chunk: `[exec] pid=${proc.pid} cpu=${totalCpu}% rss=${totalRss}KB wall=${Date.now() - startTime}ms\n`,
                    stream: "stderr" as const,
                  }),
                });
              }
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              execEvents?.push({
                type: "progress",
                event: tag({
                  type: "repl_progress" as const,
                  runId,
                  id: uuidv7(),
                  chunk: `[exec] metrics poll error: ${message}\n`,
                  stream: "stderr" as const,
                }),
              });
              break;
            }
          }
        };

        const stdoutReader = proc.stdout.getReader();
        const stderrReader = proc.stderr.getReader();

        const kill = () => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {}
          try {
            proc.kill(9);
          } catch {}
          stdoutReader.cancel().catch(() => {});
          stderrReader.cancel().catch(() => {});
        };

        // Release readers — drainStream will get its own
        stdoutReader.releaseLock();
        stderrReader.releaseLock();

        const metricsPromise = pollMetrics();

        const completionPromise = (async () => {
          const [stdout, stderr] = await Promise.all([
            drainStream(proc.stdout, "stdout"),
            drainStream(proc.stderr, "stderr"),
          ]);
          const exitCode = await proc.exited;
          return { stdout, stderr, exitCode, timedOut: false as const };
        })();

        completionPromise.catch(() => {});

        let timer: Timer;
        const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => {
            kill();
            resolve({ timedOut: true });
          }, effectiveTimeout * 1000);
        });

        const raceResult = await Promise.race([completionPromise, timeoutPromise]);
        clearTimeout(timer!);
        metricsRunning = false;
        await metricsPromise.catch(() => {});

        if (raceResult.timedOut) {
          execEvents?.push({
            type: "progress",
            event: tag({
              type: "repl_progress" as const,
              runId,
              id: uuidv7(),
              chunk: `[exec] TIMEOUT after ${effectiveTimeout}s — process killed\n`,
              stream: "stderr" as const,
            }),
          });
          return {
            exitCode: -1,
            stdout: "",
            stderr: `exec timeout: killed after ${effectiveTimeout}s`,
          };
        }

        return {
          stdout: raceResult.stdout,
          stderr: raceResult.stderr,
          exitCode: raceResult.exitCode,
        };
      };

      // Create the REPL with context data and progress streaming
      const repl = createRepl({
        context: ctx,
        llmQuery,
        exec,
        maxStdoutLength: config.maxStdoutLength,
        onProgress: (chunk, stream) => {
          execEvents?.push({
            type: "progress",
            event: tag({
              type: "repl_progress" as const,
              runId,
              id: uuidv7(),
              chunk,
              stream,
            }),
          });
        },
      });

      // Build system prompt with metadata only
      const systemPrompt = buildRlmSystemPrompt({
        contextLength: ctx.length,
        contextPrefix: ctx.slice(0, config.metadataPrefixLength),
        subPromptBudget: config.subPromptBudget,
      });

      // Internal message history for the RLM loop
      const messages: Message[] = [{ role: "system", content: systemPrompt }, ...params.messages];

      // RLM loop
      for (let i = 0; i < config.maxIterations; i++) {
        iterationsRan++;

        // Call root LLM — stream text and usage events as they arrive
        let responseText = "";
        let llmError: Error | null = null;
        for await (const event of rootHarness.invoke({
          model: params.model,
          messages,
        })) {
          if (event.type === "text") {
            responseText += event.content;
            yield tag(event);
          } else if (event.type === "reasoning") {
            yield tag(event);
          } else if (event.type === "usage") {
            // Gap #11 — accumulate usage from root LLM calls
            totalInputTokens += event.inputTokens;
            totalOutputTokens += event.outputTokens;
            yield tag(event);
          } else if (event.type === "error") {
            llmError = event.error;
            yield tag(event);
          }
        }

        // If the LLM call failed, stop the loop
        if (llmError) {
          break;
        }

        // Extract code from model response
        let code: string;
        try {
          code = extractCode(responseText);
        } catch (e) {
          // Gap #2 — yield error event for code extraction failures
          const error = e instanceof Error ? e : new Error(String(e));
          yield tag({ type: "error", runId, error });
          messages.push({ role: "assistant", content: responseText });
          messages.push({ role: "user", content: `error: ${error.message}` });
          continue;
        }

        // Gap #1 — Yield repl_input with iteration index
        const callId = uuidv7();
        yield tag({
          type: "repl_input",
          runId,
          id: callId,
          code,
          iteration: i,
        });

        // Gap #3 — capture start time for REPL execution timing
        const replStartTime = Date.now();

        // Execute in REPL with queue drain for relay events
        currentCallId = callId;
        execEvents = new AsyncQueue<ExecQueueItem>();
        const currentQueue = execEvents;

        repl.execute(code).then((r) => currentQueue.push({ type: "repl_done", result: r }));

        let result: ReplExecutionResult;
        while (true) {
          const item = await currentQueue.pop();
          if (item.type === "repl_done") {
            result = item.result;
            break;
          }
          yield item.event;
        }

        execEvents = undefined;

        const durationMs = Date.now() - replStartTime;

        // Gap #1, #3, #10 — Yield repl_output with iteration, timing, and truncation
        yield tag({
          type: "repl_output",
          runId,
          id: callId,
          stdout: result.stdout,
          done: result.done,
          ...(result.error ? { error: result.error } : {}),
          iteration: i,
          durationMs,
          ...(result.truncated ? { truncated: true } : {}),
        });

        // Append to internal message history
        messages.push({ role: "assistant", content: responseText });

        const feedbackParts: string[] = [];
        if (result.stdout) feedbackParts.push(`stdout:\n${result.stdout}`);
        if (result.error) feedbackParts.push(`error: ${result.error}`);
        if (feedbackParts.length === 0) feedbackParts.push("(no output)");
        messages.push({ role: "user", content: feedbackParts.join("\n") });

        // Check if done
        if (result.done && result.finalValue !== undefined) {
          // Gap #9 — set completion reason
          completionReason = "final";
          yield tag({
            type: "text",
            runId,
            id: uuidv7(),
            content: result.finalValue,
          });
          break;
        }
      }

      // Gap #9, #11 — emit harness_end with reason, iterations, and aggregate usage
      yield tag({
        type: "harness_end",
        runId,
        reason: completionReason,
        iterations: iterationsRan,
        totalUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      });
    },

    supportedModels: () => rootHarness.supportedModels(),
  };
}

export { createRlmHarness };
export type { RlmHarnessOptions };
