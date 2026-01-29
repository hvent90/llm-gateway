import { z } from "zod";
import type { ToolDefinition } from "../types";

const schema = z.object({
  task: z.string().describe("The task for the subagent to perform"),
});

export const agentTool: ToolDefinition<typeof schema, string> = {
  name: "agent",
  description:
    "Spawn a subagent to handle a task autonomously. The subagent has access to the same tools and will work independently to complete the task, returning its final response.",
  schema,
  execute: async ({ task }, ctx) => {
    if (!ctx.spawn) {
      throw new Error("spawn not available in tool context");
    }
    const result = await ctx.spawn(task);
    return { context: result, result };
  },
};
