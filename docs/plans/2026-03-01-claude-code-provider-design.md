# Claude Code Provider Harness

A provider harness that wraps the Claude Code CLI (`claude -p`) so that model calls route through a Claude Max subscription instead of per-token API billing.

## Motivation

Use a Claude Max subscription to drive the RLM agent (and any other harness consumer) without API costs. Claude Code CLI authenticates via `CLAUDE_CODE_OAUTH_TOKEN` and bills against the subscription.

## Architecture

```
RLM harness loop (or any consumer)
  └── rootHarness.invoke({ model, messages })
      └── claude-code provider harness
          └── Bun.spawn(["claude", "-p", ...])
              └── Claude Code CLI (Max subscription)
```

The provider harness is a dumb text-in/text-out pipe. It knows nothing about RLM, code blocks, REPL execution, or `FINAL()`. It implements `GeneratorHarnessModule` identically to Zen, Anthropic, OpenAI, etc.

## File

`packages/ai/harness/providers/claude-code.ts`

## Interface

```typescript
interface ClaudeCodeHarnessOptions {
  model?: string;    // default model
  cliPath?: string;  // path to claude binary (default: "claude")
}

function createGeneratorHarness(options?: ClaudeCodeHarnessOptions): GeneratorHarnessModule
```

Usage:

```typescript
import { createGeneratorHarness } from "./harness/providers/claude-code";

const rlm = createRlmHarness({
  rootHarness: createGeneratorHarness(),
  config,
});
```

## invoke() Flow

Each `invoke()` call:

1. **Extract system prompt** from `params.messages` (first message with `role: "system"`)
2. **Serialize remaining messages** into a structured prompt string with role markers
3. **Spawn** `claude -p` via `Bun.spawn` with flags:
   - `--system-prompt <system>` — the consumer's system prompt (e.g. RLM's metadata-only prompt)
   - `--model <model>` — passed through from params
   - `--output-format stream-json` — NDJSON streaming
   - `--verbose` — enables stream events in output
   - `--allowedTools ""` — disables all built-in tools
4. **Pipe** serialized prompt to stdin, close stdin
5. **Parse** stdout line-by-line as NDJSON
6. **Map** stream events to `HarnessEvent`, yield them
7. **Wait** for process exit, yield error if non-zero

## Message Serialization

The provider receives `Message[]` but `claude -p` takes a single prompt string. We serialize the conversation history with XML-style role markers:

**First turn** (system + user only): user message content passed directly as prompt, no wrapping.

**Subsequent turns** (multi-turn history):

```xml
<user>
Find the 5 longest words in the context
</user>

<assistant>
```js
const words = context.split(/\s+/).sort((a,b) => b.length - a.length);
console.log(words.slice(0, 5).join(', '));
```
</assistant>

<user>
stdout (42 chars):
approximately, communication, understanding, extraordinary, international
</user>
```

System message is always extracted and passed via `--system-prompt`, never included in the serialized prompt.

## Event Mapping

Parse each NDJSON line from stdout. Lines with `type: "stream_event"` contain raw Claude API events:

| Stream Event | HarnessEvent |
|---|---|
| `content_block_delta` + `text_delta` | `{ type: "text", runId, id: textId, content }` |
| `content_block_delta` + `thinking_delta` | `{ type: "reasoning", runId, id: reasoningId, content }` |
| `message_delta` with usage | `{ type: "usage", runId, inputTokens, outputTokens }` |
| `type: "result"` with usage | `{ type: "usage" }` (fallback) |
| Process error / parse failure | `{ type: "error", runId, error }` |

Stable IDs: `textId` and `reasoningId` are generated once per invoke (same as Zen) so clients can append streamed chunks.

`parentId` tagging applied to all events when `params.env.parentId` is set.

Ignored events: `message_start`, `content_block_start`, `content_block_stop`, `message_stop`, `tool_use` blocks, and non-stream SDK message types (`system`, `assistant`).

## Authentication

Requires `CLAUDE_CODE_OAUTH_TOKEN` environment variable. The harness does not handle auth — if the token is missing or invalid, `claude -p` exits non-zero and the error surfaces as an `error` event.

## Error Handling

- **Non-zero exit**: yield `error` event with stderr content
- **Spawn failure** (e.g. `claude` not on PATH): yield `error` event
- **Malformed JSON lines**: skip (same as Zen)
- **Empty stdout**: yield `error` ("No response from Claude Code CLI")
- **Rate limiting**: Max subscription caps surface as CLI errors, yielded as `error` events. RLM's loop breaks on error naturally.
- **No timeout**: RLM's `maxIterations` is the safety valve

## Testing

- **Unit tests**: mock `Bun.spawn` to return canned NDJSON, verify `HarnessEvent` mapping
- **Message serialization tests**: `serializeMessages()` tested directly for single-turn, multi-turn, system message extraction
- **Integration test**: real `claude -p` call with trivial prompt, gated behind `CLAUDE_CODE_OAUTH_TOKEN` env check

## supportedModels()

Returns a static list: `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`. Can be expanded later or made dynamic.
