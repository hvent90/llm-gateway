import { z } from "zod";
import { spawn } from "bun";
import type { ToolDefinition } from "../types";

const schema = z.object({
  command: z.string().describe("The shell command to execute"),
});

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const bashTool: ToolDefinition<typeof schema, BashResult> = {
  name: "bash",
  description: "Execute a shell command. Returns stdout, stderr, and exit code.",
  schema,
  execute: async ({ command }) => {
    const proc = spawn({
      cmd: ["sh", "-c", command],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const result: BashResult = { exitCode, stdout, stderr };

    let context = "";
    if (stdout) context += `stdout:\n${stdout}\n`;
    if (stderr) context += `stderr:\n${stderr}\n`;
    context += `exit code: ${exitCode}`;

    return { context, result };
  },
};
