import { z } from "zod";
import { spawn } from "bun";
import type { ToolDefinition } from "../types";

const schema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().positive().default(5).describe("Timeout in seconds (default: 5)"),
});

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const bashTool: ToolDefinition<typeof schema, BashResult> = {
  name: "bash",
  description: "Execute a non-sudo shell command. Returns stdout, stderr, and exit code.",
  schema,
  execute: async ({ command, timeout }) => {
    const proc = spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    const completionPromise = (async () => {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    })();

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill();
        }
        resolve(null);
      }, timeout * 1000),
    );

    const raceResult = await Promise.race([
      completionPromise.then((r) => ({ ...r, timedOut: false as const })),
      timeoutPromise.then(() => ({ stdout: "", stderr: "", exitCode: -1, timedOut: true as const })),
    ]);

    if (raceResult.timedOut) {
      return {
        context: `Command timed out after ${timeout} seconds`,
        result: { exitCode: raceResult.exitCode, stdout: raceResult.stdout, stderr: raceResult.stderr },
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
