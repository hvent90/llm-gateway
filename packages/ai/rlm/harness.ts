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
}

/** Extract code from a model response. Looks for fenced JS blocks, falls back to entire text. */
function extractCode(text: string): string {
  const fenceRe = /```(?:js|javascript)\n([\s\S]*?)```/;
  const match = fenceRe.exec(text);
  if (match?.[1]) return match[1].trim();
  return text.trim();
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
      const parentId = params.context?.parentId;

      const tag = <T extends { runId: string }>(event: T): T & { parentId?: string } => {
        const tagged = { ...event, runId };
        if (parentId) (tagged as T & { parentId?: string }).parentId = parentId;
        else delete (tagged as T & { parentId?: string }).parentId;
        return tagged;
      };

      yield tag({ type: "harness_start", runId });

      // Find the user prompt — last user message
      const userMessage = [...params.messages].reverse().find((m) => m.role === "user");
      const userPrompt =
        typeof userMessage?.content === "string"
          ? userMessage.content
          : ((userMessage?.content?.find((p) => p.type === "text") as { text: string } | undefined)
              ?.text ?? "");

      // llm_query callback: send a prompt to the sub-harness
      const llmQuery = async (prompt: string): Promise<string> => {
        const { text } = await collectText(
          subHarness.invoke({
            model: config.subModel,
            messages: [{ role: "user", content: prompt }],
          }),
        );
        return text;
      };

      // Queue for exec relay events that need to be yielded from the generator
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
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });

        const startTime = Date.now();

        const toolCallId = currentCallId ?? uuidv7();

        // Helper to push a tool_progress event onto the queue
        const pushProgress = (content: unknown) => {
          execEvents?.push({
            type: "progress",
            event: tag({
              type: "tool_progress" as const,
              runId,
              id: uuidv7(),
              toolCallId,
              name: "exec",
              content,
            }),
          });
        };

        // Drain a readable stream, collecting into buffer and pushing progress events
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
              pushProgress({ channel, data: text });
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
                pushProgress({
                  pid: proc.pid,
                  cpuPercent: totalCpu,
                  rssKb: totalRss,
                  wallMs: Date.now() - startTime,
                });
              }
            } catch {
              // Process may have exited — stop polling
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
          return { exitCode: -1, stdout: "", stderr: "" };
        }

        return {
          stdout: raceResult.stdout,
          stderr: raceResult.stderr,
          exitCode: raceResult.exitCode,
        };
      };

      // Create the REPL with prompt as context
      const repl = createRepl({
        context: userPrompt,
        llmQuery,
        subRlm: llmQuery, // v1: sub_rlm delegates to llm_query
        exec,
        maxStdoutLength: config.maxStdoutLength,
      });

      // Build system prompt with metadata only
      const systemPrompt = buildRlmSystemPrompt({
        contextLength: userPrompt.length,
        contextPrefix: userPrompt.slice(0, config.metadataPrefixLength),
      });

      // Internal message history for the RLM loop
      const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      // RLM loop
      for (let i = 0; i < config.maxIterations; i++) {
        // Call root LLM
        const { text: responseText, events } = await collectText(
          rootHarness.invoke({
            model: params.model,
            messages,
          }),
        );

        // Pass through usage events
        for (const event of events) {
          if (event.type === "usage") yield tag(event);
        }

        // Extract code from model response
        const code = extractCode(responseText);

        // Yield tool_call for the REPL execution
        const callId = uuidv7();
        yield tag({
          type: "tool_call",
          runId,
          id: callId,
          name: "repl_execute",
          input: { code },
        });

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

        // Build output for tool_result
        const output = result.error
          ? { error: result.error, stdout: result.stdout }
          : { stdout: result.stdout };

        yield tag({
          type: "tool_result",
          runId,
          id: callId,
          name: "repl_execute",
          output,
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
          yield tag({
            type: "text",
            runId,
            id: uuidv7(),
            content: result.finalValue,
          });
          break;
        }
      }

      yield tag({ type: "harness_end", runId });
    },

    supportedModels: () => rootHarness.supportedModels(),
  };
}

export { createRlmHarness };
export type { RlmHarnessOptions };
