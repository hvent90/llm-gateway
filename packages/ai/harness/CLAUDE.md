# packages/ai/harness

Harness implementations for LLM providers and the agent wrapper that adds tool execution and permissions.

## Architecture

Provider harnesses make single LLM API calls and yield events. The agent harness wraps any provider harness to add an agentic loop with tool execution, permission checking, and iteration.

Composition: `createAgentHarness({ harness: createGeneratorHarness() })`

## Key Files

### Agent Harness

- `agent.ts` — createAgentHarness: wraps a GeneratorHarnessModule with agentic loop
- Loops until no tool calls or maxIterations reached
- Permission checking via relay events and deferred promises
- Concurrent tool execution, message history accumulation
- Adds: harness_start, harness_end, tool_result, relay events

### Provider Harnesses

Single-iteration LLM adapters in `providers/`:

- `zen.ts` — OpenAI-compatible API (default), supports reasoning_content
- `anthropic.ts` — Anthropic Messages API
- `openai.ts` — OpenAI Chat Completions API
- `openrouter.ts` — OpenRouter aggregator
- `deterministic.ts` — Testing harness with canned responses

Providers implement `GeneratorHarnessModule` from `types.ts`: `invoke(params)` returns `AsyncIterable<HarnessEvent>`, `supportedModels()` returns model IDs.

What providers do NOT do: execute tools, handle permissions, or loop after tool calls — that's the agent harness's job.

## Canonical Example

See `providers/zen.ts` — simplest and most complete provider implementation. Use as reference when adding new providers.

## Docs

- `docs/adding-a-provider.md` — Guide for adding new LLM providers
