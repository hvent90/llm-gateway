import { spawn } from "bun";
import { startEventServer } from "./event-server";

export interface EvalConfig {
  harness: string;
  dataset: string;
  taskNames: string[];
  model: string;
  concurrency: number;
}

export async function runEval(
  config: EvalConfig,
  onOutput: (line: string) => void,
  onEvent?: (event: unknown) => void,
): Promise<number> {
  const agentMap: Record<string, string> = {
    rlm: "evals.agents.rlm:RlmAgent",
  };

  // Start event relay server so Docker containers can POST events back
  let eventServer: ReturnType<typeof startEventServer> | undefined;
  if (onEvent) {
    try {
      eventServer = startEventServer(onEvent);
      onOutput(`[eval] Event relay listening on port ${eventServer.port}`);
    } catch (error) {
      // Eval runs without live REPL events if local HTTP bind fails.
      onOutput(`[eval] Event relay disabled: ${String(error)}`);
    }
  }

  const cmd = [
    "harbor",
    "run",
    "-d",
    config.dataset,
    "--jobs-dir",
    "evals/jobs",
    "--agent-import-path",
    agentMap[config.harness] ?? config.harness,
    "-m",
    config.model,
    "-n",
    String(config.concurrency),
  ];

  for (const task of config.taskNames) {
    cmd.push("-t", task);
  }

  const runCwd = import.meta.dir + "/../..";
  onOutput(`[eval] Working directory: ${runCwd}`);
  onOutput(`[eval] Starting: ${cmd.join(" ")}`);

  const proc = spawn({
    cmd,
    cwd: runCwd, // repo root
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      ...(eventServer ? { EVAL_EVENT_PORT: String(eventServer.port) } : {}),
    },
  });

  async function readStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/);
      const hasTrailingNewline = /\r\n$|\n$|\r$/.test(buffer);
      buffer = hasTrailingNewline ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        onOutput(line);
      }
      // Harbor can write long chunks without newline; flush them immediately.
      if (buffer) {
        onOutput(buffer);
        buffer = "";
      }
    }

    buffer += decoder.decode();
    if (buffer) onOutput(buffer);
  }

  await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);

  const exitCode = await proc.exited;

  if (eventServer) {
    eventServer.server.stop();
  }

  return exitCode;
}
