# Tools

## Why

Built-in agent capabilities. These tools define what agents can actually DO — execute shell commands, read files, apply patches, and spawn subagents.

## What

Four core tools:

- `bash.ts` — Execute non-sudo shell commands with timeout. Returns stdout/stderr/exitCode. Derives permissions from command prefix (first word + glob).
- `read.ts` — Read files: text with line numbers, images as base64, PDFs as base64. Respects file size limits.
- `patch.ts` — Apply unified diff patches to files. Uses lib/patch-parser.ts and lib/patch-apply.ts. Checks FileTime to prevent editing stale files.
- `agent.ts` — Spawn a subagent via ctx.spawn(). Sends task description, returns final assistant text.

Supporting utilities in `lib/`:

- `filetime.ts` — Tracks read/write timestamps for conflict detection
- `patch-parser.ts` — Parses unified diff format into PatchOp structures
- `patch-apply.ts` — Applies parsed patches with context-based hunk matching

## How

Each tool implements `ToolDefinition` from `types.ts`:

- `name` — tool identifier
- `description` — shown to the LLM
- `schema` — zod schema for input validation (converted to JSON Schema)
- `execute(input, ctx)` — receives parsed args and ToolContext with parentId, spawn, fileTime
- `derivePermission` (optional) — returns ToolPermission for "always allow" feature

The execute function returns `ToolExecutionResult` with:

- `context` — string injected into agent's conversation (what the agent "sees")
- `result` — programmatic return value (available to harness)

Tools are registered in index.ts and passed to harness via `invoke({ tools: [...] })`.

## Examples

See `bash.ts` for the canonical simple tool implementation. See `patch.ts` for FileTime conflict detection and locking during writes.

## Docs

→ `docs/adding-a-tool.md` — Step-by-step guide for adding new tools
