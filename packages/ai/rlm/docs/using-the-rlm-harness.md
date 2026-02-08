# Using the RLM Harness

This guide covers creating, configuring, and invoking the RLM harness, and integrating it with the existing provider/agent system.

## Quick Start

```typescript
import { createRlmHarness } from "@/packages/ai/rlm/harness";
import { createGeneratorHarness } from "@/packages/ai/harness/providers/zen";

const provider = createGeneratorHarness({ model: "kimi-k2.5" });

const rlm = createRlmHarness({
  rootHarness: provider,
  config: {
    maxIterations: 10,
    maxStdoutLength: 4000,
    metadataPrefixLength: 200,
  },
});

for await (const event of rlm.invoke({
  messages: [{ role: "user", content: longDocument }],
})) {
  console.log(event.type, event);
}
```

## Configuration

`RlmConfig` (types.ts:6-17) controls the inference loop:

| Field | Type | Description |
|-------|------|-------------|
| `maxIterations` | `number` | Max REPL turns before forcing completion. Safety limit to prevent infinite loops. |
| `maxStdoutLength` | `number` | Max characters of stdout fed back per turn. Prevents the model from flooding its own context. |
| `metadataPrefixLength` | `number` | Length of the context prefix shown in the system prompt metadata. Gives the model a hint about the data. |
| `subModel` | `string?` | Model ID for `llm_query` calls inside the REPL. Defaults to the sub-harness's default model. Use a cheaper model here. |

### Choosing values

- **maxIterations**: 10 is a reasonable default. Simple tasks finish in 1-3 turns. Complex chunking might take 5-8. Set higher for open-ended exploration.
- **maxStdoutLength**: 4000 (default) works well. Too low and the model can't see its own output; too high and context fills up with debug output.
- **metadataPrefixLength**: 200 gives the model enough to orient. Increase for inputs where the beginning is important.

## Creating the Harness

### Basic: same model for root and sub calls

```typescript
const provider = createGeneratorHarness({ model: "kimi-k2.5" });

const rlm = createRlmHarness({
  rootHarness: provider,
  config: {
    maxIterations: 10,
    maxStdoutLength: 4000,
    metadataPrefixLength: 200,
  },
});
```

### Separate sub-harness for cheaper llm_query calls

```typescript
const rootProvider = createGeneratorHarness({ model: "kimi-k2.5" });
const subProvider = createGeneratorHarness({ model: "glm-4.7" });

const rlm = createRlmHarness({
  rootHarness: rootProvider,
  subHarness: subProvider,
  config: {
    maxIterations: 10,
    maxStdoutLength: 4000,
    metadataPrefixLength: 200,
  },
});
```

The `rootHarness` handles the code-generating calls (model writes JavaScript). The `subHarness` handles `llm_query()` calls inside the REPL (typically simpler tasks like summarization).

## Invoking the Harness

The RLM harness implements `GeneratorHarnessModule`, so it's invoked the same way as any provider:

```typescript
const events = rlm.invoke({
  messages: [{ role: "user", content: userInput }],
});

for await (const event of events) {
  switch (event.type) {
    case "harness_start":
      // Session started
      break;
    case "tool_call":
      // Model wrote code: event.input.code
      break;
    case "tool_result":
      // REPL output: event.output.stdout, event.output.error
      break;
    case "text":
      // Final answer: event.content
      break;
    case "usage":
      // Token usage from an LLM call
      break;
    case "harness_end":
      // Session complete
      break;
  }
}
```

### Important: the user prompt is the context

The harness extracts the last user message from `params.messages` and uses it as the REPL's `context` variable. This means the user's message IS the data the model will process. For long document processing, put the document directly in the user message.

## Composing with the Agent Harness

Since the RLM harness implements `GeneratorHarnessModule`, it can be wrapped with the agent harness for tool execution and permissions:

```typescript
import { createAgentHarness } from "@/packages/ai/harness/agent";
import { createRlmHarness } from "@/packages/ai/rlm/harness";

const rlm = createRlmHarness({
  rootHarness: provider,
  config: { /* ... */ },
});

const agent = createAgentHarness({
  harness: rlm,  // RLM harness as the provider
  tools: [bashTool, readTool],
});
```

However, note that the RLM harness runs its own internal loop. When wrapped in an agent harness, the agent's loop runs the RLM's loop on each iteration. In practice, the RLM harness is typically used as a standalone `GeneratorHarnessModule` rather than inside an agent harness, since it manages its own iteration.

## Testing

Use the deterministic provider (harness/providers/deterministic.ts) for tests:

```typescript
import { createDeterministicHarness } from "@/packages/ai/harness/providers/deterministic";
import { createRlmHarness } from "@/packages/ai/rlm/harness";

const rootHarness = createDeterministicHarness({
  model: "deterministic",
  responses: [
    { events: [{ type: "text", content: 'FINAL("hello world")' }] },
  ],
});

const rlm = createRlmHarness({
  rootHarness,
  config: {
    maxIterations: 10,
    maxStdoutLength: 4000,
    metadataPrefixLength: 200,
  },
});

const events = [];
for await (const event of rlm.invoke({
  messages: [{ role: "user", content: "test input" }],
})) {
  events.push(event);
}

// events: harness_start → tool_call → tool_result → text("hello world") → harness_end
```

For multi-turn tests, provide multiple responses. The deterministic harness serves them in order:

```typescript
const rootHarness = createDeterministicHarness({
  responses: [
    { events: [{ type: "text", content: "print(context.length)" }] },
    { events: [{ type: "text", content: 'FINAL("length is " + context.length)' }] },
  ],
});
```

See `__tests__/harness.test.ts` for comprehensive examples.

## Using the REPL Directly

The REPL can be used independently of the harness for testing or custom loops:

```typescript
import { createRepl } from "@/packages/ai/rlm/repl";

const repl = createRepl({
  context: "some long document...",
  llmQuery: async (prompt) => callMyLlm(prompt),
});

// Execute code
const result = await repl.execute('print(context.slice(0, 100));');
console.log(result.stdout); // first 100 chars

// Variables persist
await repl.execute('scope.summary = await llm_query("Summarize: " + context);');
const state = repl.getState();
console.log(state.variables.get("summary"));

// Finish
const final = await repl.execute('FINAL_VAR("summary");');
console.log(final.done);       // true
console.log(final.finalValue); // the summary
```

## Error Handling

### REPL errors don't crash the harness

If the model writes code that throws, the error is captured and returned as part of the `tool_result` event. The harness feeds the error back to the model as a user message, giving it a chance to correct its approach:

```
Model: undefinedVar.boom
REPL:  error: undefinedVar is not defined
Model: // Let me try a different approach...
       FINAL("recovered")
```

### maxIterations as a safety net

If the model never calls `FINAL()`, the loop stops after `maxIterations`. No `text` event is emitted — the harness yields `harness_end` and the session completes without a final answer. Consumers should handle this case.
