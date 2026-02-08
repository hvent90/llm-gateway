# packages/ai/rlm

Recursive Language Models (RLMs) treat LLM input as a REPL environment variable, not direct context. The model writes JavaScript to examine, chunk, and recursively process arbitrarily long inputs. The REPL also provides `exec()` for running shell commands, making RLM a general-purpose "model writes code to solve problems" harness.

## Architecture

The RLM harness wraps any provider harness and runs an inference loop: the model receives metadata about the input (length, prefix), writes code to explore it through a sandboxed REPL, and iterates until it calls `FINAL()` or hits `maxIterations`.

Composition: `createRlmHarness({ rootHarness: createGeneratorHarness(), config })`

## Key Files

- `types.ts` — `RlmConfig`, `ReplState`, `ReplExecutionResult`, callback types (`LlmQueryFn`, `SubRlmFn`, `ExecFn`)
- `repl.ts` — `createRepl()`: sandboxed async JS REPL with persistent scope, stdout capture, and `FINAL()`/`FINAL_VAR()` completion signals
- `system-prompt.ts` — `buildRlmSystemPrompt()`: instructs the model on REPL usage, available functions, and coding patterns
- `harness.ts` — `createRlmHarness()`: the main inference loop. Implements `GeneratorHarnessModule` so it composes with the agent harness and orchestrator like any provider

## How It Works

1. Extract user prompt from messages, create REPL with prompt as `context`
2. Build system prompt with metadata only (length, prefix) — model never sees the full input
3. Each iteration: call provider → extract code from fenced blocks → execute in REPL → yield `tool_call`/`tool_result` events → append stdout/error to message history
4. If `FINAL()`/`FINAL_VAR()` called → yield final `text` event, break
5. Yield `harness_end`

## Event Mapping

- `harness_start` / `harness_end` — lifecycle boundaries
- `tool_call` (name: `repl_execute`) — the code being executed
- `tool_result` — stdout/error from REPL execution
- `text` — final answer when `FINAL()` is called
- `usage` — passed through from provider calls

## Testing

Tests in `__tests__/`. Uses the deterministic provider for harness tests. REPL tests use direct callbacks.

## Docs

- `docs/how-rlm-works.md` — Concept, inference loop, and architecture
- `docs/using-the-rlm-harness.md` — Practical usage guide with code examples
