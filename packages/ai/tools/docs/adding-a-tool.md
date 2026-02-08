# Adding a Tool

This guide walks through adding a new tool to the framework.

## 1. Tool Definition Interface

Every tool implements `ToolDefinition` (types.ts:33-39):

```typescript
interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  name: string;
  description: string;
  schema: TSchema;
  execute?: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolExecutionResult<TResult>>;
  derivePermission?: (params: Record<string, unknown>) => ToolPermission;
}
```

## 2. Schema

Define your input schema using Zod. It gets converted to JSON Schema for the LLM:

```typescript
import { z } from "zod";

const schema = z.object({
  command: z.string().describe("The shell command to execute"),
  timeout: z.number().positive().default(5).describe("Timeout in seconds"),
});
```

Descriptions are important — they're shown to the LLM to guide tool usage.

## 3. Execute Function

The execute function receives:

- `input: z.infer<TSchema>` — parsed and validated input
- `ctx: ToolContext` — contains:
  - `parentId?: string` — ID of the tool call that spawned this context
  - `spawn?: (task: string) => Promise<string>` — spawn a subagent (see agent.ts:14-16)
  - `fileTime: FileTime` — tracks file mtimes for conflict detection (see filetime.ts)

Return value is `ToolExecutionResult<TResult>`:

```typescript
{
  context?: string;  // Injected into agent's conversation as the tool result
  result?: TResult;  // Programmatic return value, available to harness
}
```

The `context` string is what the agent sees. The `result` is for programmatic consumers.

Example from bash.ts:42-108:

```typescript
execute: async ({ command, timeout }, ctx) => {
  // ... execute command ...
  const result = { exitCode, stdout, stderr };

  let context = "";
  if (stdout) context += `stdout:\n${stdout}\n`;
  if (stderr) context += `stderr:\n${stderr}\n`;
  context += `exit code: ${exitCode}`;

  return { context, result };
}
```

## 4. Permission Derivation (Optional)

The `derivePermission` function lets you create a ToolPermission for the "always allow" feature. It receives the raw params and returns a permission pattern.

Example from bash.ts:34-41:

```typescript
derivePermission: (params): ToolPermission => {
  const command = String(params.command ?? "");
  const spaceIndex = command.indexOf(" ");
  if (spaceIndex === -1) {
    return { tool: "bash", params: { command } };
  }
  // Extract command prefix + "**" glob
  return { tool: "bash", params: { command: command.slice(0, spaceIndex) + " **" } };
}
```

This allows users to "always allow" patterns like `git **` or `npm **`.

## 5. FileTime for Edit Conflict Detection

If your tool writes files, use FileTime to prevent editing stale content:

1. `fileTime.read(path)` — record mtime after reading
2. `fileTime.assert(path)` — verify file hasn't changed before writing
3. `fileTime.withLock(path, fn)` — serialize operations on the same file

Example from patch.ts:92-99:

```typescript
await fileTime.assert(op.path);
await fileTime.withLock(op.path, async () => {
  const content = await readFile(op.path, "utf-8");
  const updated = applyHunks(content, op.hunks);
  await writeFile(op.path, updated);
  await fileTime.read(op.path); // Record new mtime
});
```

## 6. Registration

1. Export your tool from its file:

```typescript
export const myTool: ToolDefinition<typeof schema, MyResult> = {
  name: "my_tool",
  description: "...",
  schema,
  execute: async (input, ctx) => { ... },
};
```

2. Add to `tools/index.ts`:

```typescript
export { myTool } from "./my-tool";
```

3. Import in your harness or server and add to tools array:

```typescript
import { myTool } from "@/packages/ai/tools";

const tools = [bashTool, readTool, patchTool, agentTool, myTool];
```

## Reference Implementation

See `bash.ts` for the canonical simple tool implementation — it demonstrates schema, execute, derivePermission, and proper result formatting.
