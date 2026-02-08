import { z } from "zod";
import type { ToolDefinition, ToolPermission } from "../types";
import { execShell, type ShellResult } from "./lib/shell";

const schema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().positive().default(5).describe("Timeout in seconds (default: 5)"),
});

export const bashTool: ToolDefinition<typeof schema, ShellResult> = {
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
    const result = await execShell({ command, timeout });

    if (result.exitCode === -1 && !result.stdout && !result.stderr) {
      return {
        context: `Command timed out after ${timeout} seconds`,
        result: { exitCode: -1, stdout: "", stderr: "" },
      };
    }

    const { stdout, stderr, exitCode } = result;

    let context = "";
    if (stdout) context += `stdout:\n${stdout}\n`;
    if (stderr) context += `stderr:\n${stderr}\n`;
    context += `exit code: ${exitCode}`;

    return { context, result: { exitCode, stdout, stderr } };
  },
};
