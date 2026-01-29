import { describe, test, expect } from "bun:test";
import { agentTool } from "../agent";

describe("Agent Tool", () => {
  test("has correct name and schema", () => {
    expect(agentTool.name).toBe("agent");
    expect(agentTool.schema).toBeDefined();
  });

  test("calls ctx.spawn with task and returns result as context", async () => {
    const spawnFn = async (task: string) => `Result for: ${task}`;

    const result = await agentTool.execute!(
      { task: "do something" },
      {
        parentId: "tc-1",
        spawn: spawnFn,
      },
    );

    expect(result.context).toBe("Result for: do something");
  });

  test("throws if spawn is not provided in context", async () => {
    expect(agentTool.execute!({ task: "do something" }, { parentId: "tc-1" })).rejects.toThrow();
  });
});
