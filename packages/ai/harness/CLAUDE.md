# packages/ai/harness

Harness implementations for LLM providers and the agent wrapper that adds tool execution and permissions.

## Architecture

Provider harnesses make single LLM API calls and yield events. The agent harness wraps any provider harness to add an agentic loop with tool execution, permission checking, and iteration.

Composition: `createAgentHarness({ harness: createGeneratorHarness() })`

## Key Files

### Agent Harness
- `agent.ts:30` — createAgentHarness: wraps a GeneratorHarnessModule with agentic loop

What it does:
- Loops until no tool calls or maxIterations reached (agent.ts:54)
- Permission checking: yields relay events (agent.ts:162), pauses via deferred promise (agent.ts:176) until respond() is called
- Concurrent tool execution via Promise.all (agent.ts:252)
- Message history accumulation (agent.ts:49, 120, 149, 304)
- Iteration overflow: summarization mode when maxIterations exceeded (agent.ts:55-66)

Events added: harness_start (46), harness_end (115, 245, 313), tool_result (268, 186, 216), relay (162)

### Provider Harnesses

Single-iteration LLM adapters in `providers/`:

- `zen.ts:147` — OpenAI-compatible API (default), supports reasoning_content
- `anthropic.ts` — Anthropic Messages API
- `openai.ts` — OpenAI Chat Completions API
- `openrouter.ts` — OpenRouter aggregator
- `deterministic.ts` — Testing harness with canned responses

Provider harnesses implement `GeneratorHarnessModule` (types.ts:134):
- `invoke(params)` returns `AsyncIterable<HarnessEvent>`
- `supportedModels()` returns available model IDs

What providers do:
- Convert messages/tools to provider format (zen.ts:34, 68)
- Make API call (zen.ts:173)
- Parse SSE stream (zen.ts:82)
- Yield events: text (249), reasoning (239), tool_call (294), usage (305), error (183)

What providers do NOT do:
- Execute tools (that's agent harness's job)
- Handle permissions (that's agent harness's job)
- Loop after tool calls (that's agent harness's job)

## Canonical Example

See `providers/zen.ts` — simplest and most complete provider implementation. Use as reference when adding new providers.

## Docs

- `docs/adding-a-provider.md` — Guide for adding new LLM providers
