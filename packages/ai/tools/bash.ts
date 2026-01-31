import { z } from "zod";
import { spawn } from "bun";
import type { ToolDefinition, ToolPermission } from "../types";

const schema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().positive().default(5).describe("Timeout in seconds (default: 5)"),
});

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function readStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // Stream cancelled or errored — return whatever we collected
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export const bashTool: ToolDefinition<typeof schema, BashResult> = {
  name: "bash",
  description: "Execute a non-sudo shell command. Returns stdout, stderr, and exit code.",
  schema,
  derivePermission: (params): ToolPermission => {
    const command = String(params.command ?? "");
    const spaceIndex = command.indexOf(" ");
    if (spaceIndex === -1) {
      return { tool: "bash", params: { command } };
    }
    return { tool: "bash", params: { command: command.slice(0, spaceIndex) + " **" } };
  },
  execute: async ({ command, timeout }) => {
    const proc = spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();

    const kill = () => {
      // Kill process group AND individual process — belt and suspenders.
      // The group kill gets pipeline children; the direct kill is a fallback.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
      try {
        proc.kill(9);
      } catch {}
      // Cancel stream readers so the completion promise can resolve
      // instead of dangling with open pipe references.
      stdoutReader.cancel().catch(() => {});
      stderrReader.cancel().catch(() => {});
    };

    const completionPromise = (async () => {
      const [stdout, stderr] = await Promise.all([
        readStream(stdoutReader),
        readStream(stderrReader),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode, timedOut: false as const };
    })();

    // Suppress unhandled rejection if timeout wins the race
    // and the completion promise later rejects from stream cleanup.
    completionPromise.catch(() => {});

    let timer: Timer;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        kill();
        resolve({ timedOut: true });
      }, timeout * 1000);
    });

    const raceResult = await Promise.race([completionPromise, timeoutPromise]);
    clearTimeout(timer!);

    if (raceResult.timedOut) {
      return {
        context: `Command timed out after ${timeout} seconds`,
        result: { exitCode: -1, stdout: "", stderr: "" },
      };
    }

    const { stdout, stderr, exitCode } = raceResult;
    const result: BashResult = { exitCode, stdout, stderr };

    let context = "";
    if (stdout) context += `stdout:\n${stdout}\n`;
    if (stderr) context += `stderr:\n${stderr}\n`;
    context += `exit code: ${exitCode}`;

    return { context, result };
  },
};
