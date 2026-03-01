# packages/ai/rlm

Recursive Language Models (RLMs) treat LLM input as a REPL environment variable, not direct context. The model writes JavaScript to examine, chunk, and recursively process arbitrarily long inputs. The REPL also provides `exec()` for running shell commands, making RLM a general-purpose "model writes code to solve problems" harness.

## Architecture

The RLM harness wraps any provider harness and runs an inference loop: the model receives metadata about the input (length, prefix), writes code to explore it through a sandboxed REPL, and iterates until it calls `FINAL()` or hits `maxIterations`.

Composition: `createRlmHarness({ rootHarness: createGeneratorHarness(), config })`

## Key Files

- `types.ts` — `RlmConfig`, `ReplState`, `ReplExecutionResult`, callback types (`LlmQueryFn`, `ExecFn`)
- `repl.ts` — `createRepl()`: sandboxed async JS REPL with persistent scope, stdout capture, and `FINAL()` completion signal
- `system-prompt.ts` — `buildRlmSystemPrompt()`: instructs the model on REPL usage, available functions, and coding patterns
- `harness.ts` — `createRlmHarness()`: the main inference loop. Implements `GeneratorHarnessModule` so it composes with the agent harness and orchestrator like any provider

## How It Works

1. Extract user prompt from messages, create REPL with prompt as `context`
2. Build system prompt with metadata only (length, prefix) — model never sees the full input
3. Each iteration: stream LLM response (yields `text`/`reasoning`/`usage`) → extract code from fenced block (exactly one per turn) → execute in REPL → yield `repl_input`/`repl_progress`/`repl_output` events → append stdout/error to message history
4. If `FINAL()` called → yield final `text` event, break
5. Yield `harness_end`

## Event Mapping

- `harness_start` — `{ depth?, maxIterations? }` — lifecycle start with optional recursion depth and iteration limit
- `harness_end` — `{ reason?, iterations?, totalUsage? }` — lifecycle end with completion reason (`"final"` | `"max_iterations"`), iteration count, and aggregate token usage
- `text` — streamed LLM response tokens (each turn) + final answer when `FINAL()` is called
- `reasoning` — streamed reasoning tokens from the LLM (if model supports it)
- `repl_input` — `{ code, iteration? }` — the extracted code about to execute, with zero-based loop index
- `repl_progress` — `{ chunk, stream: "stdout" | "stderr" }` — live output during execution (console.log, exec streams, metrics, llm_query completion, timeout notices)
- `repl_output` — `{ stdout, error?, done, iteration?, durationMs?, truncated? }` — complete execution result with timing and truncation flag
- `error` — yielded on code extraction failures (e.g. multiple code blocks)
- `relay` (kind: `permission`) — HITL approval for exec() when permissions are provided
- `usage` — passed through from root provider calls; also forwarded from flat llm_query sub-calls

## HITL Relay for exec()

When `permissions` is passed to `invoke()`, exec calls are gated via relay events using an AsyncQueue bridge. The exec callback pushes relay events onto a queue; the harness drain loop yields them from the generator. The orchestrator resolves relays, which unblocks the exec callback inside `repl.execute()`. Without permissions, exec runs freely (backward compat).

## Testing

Tests in `__tests__/`. Uses the deterministic provider for harness tests. REPL tests use direct callbacks.

## Docs

- `docs/how-rlm-works.md` — Concept, inference loop, and architecture
- `docs/using-the-rlm-harness.md` — Practical usage guide with code examples
