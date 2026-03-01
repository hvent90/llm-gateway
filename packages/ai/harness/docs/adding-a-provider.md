# Adding a New LLM Provider

This guide covers adding a new provider harness to the system.

## Interface to Implement

Provider harnesses must implement `GeneratorHarnessModule` from types.ts:134:

```typescript
export interface GeneratorHarnessModule {
  invoke(params: GeneratorInvokeParams): AsyncIterable<HarnessEvent>;
  supportedModels(): Promise<string[]>;
}
```

## What invoke() Must Do

### 1. Convert Input Format

Convert the standardized message/tool format to your provider's API format:

- Messages (types.ts:13) → provider's message schema
- Tools (types.ts:33) → provider's tool schema
- Handle multipart content (text, images, documents) if supported

See zen.ts:34 for message conversion example.

### 2. Make API Call

Call your provider's API with the converted input. Use streaming if available.

See zen.ts:173 for fetch example.

### 3. Parse Response Stream

If streaming, parse the SSE or other stream format into chunks.

See zen.ts:82 for SSE parsing example.

### 4. Yield HarnessEvent Variants

As you parse the response, yield these events:

#### text

Streamed text content from the assistant. Use a stable ID for all chunks in the same response so consumers can append.

```typescript
yield {
  type: "text",
  runId: myRunId,
  id: stableTextId,
  content: chunk,
}
```

#### reasoning (optional)

If your provider supports reasoning/thinking content (like OpenAI o1/o3), yield it separately.

```typescript
yield {
  type: "reasoning",
  runId: myRunId,
  id: stableReasoningId,
  content: chunk,
}
```

#### tool_call

When the model requests a tool call, yield the raw request. The agent harness will handle execution and permissions.

```typescript
yield {
  type: "tool_call",
  runId: myRunId,
  id: toolCallId,
  name: toolName,
  input: parsedArguments,
}
```

Handle malformed tool arguments by setting `__toolParseError` flag (see zen.ts:287-293):

```typescript
let args: unknown;
try {
  args = JSON.parse(argumentsString);
} catch (e) {
  args = {
    __toolParseError: true,
    parseError: e.message,
    rawArguments: argumentsString,
  };
}
```

#### usage

Token usage stats, typically sent once at the end.

```typescript
yield {
  type: "usage",
  runId: myRunId,
  inputTokens: promptTokens,
  outputTokens: completionTokens,
}
```

#### error

Any errors during processing. Yield this and return early.

```typescript
yield {
  type: "error",
  runId: myRunId,
  error: new Error("API call failed"),
}
```

### 5. Tag with parentId

If `params.context?.parentId` is provided, include it in all events. This links subagent events to their parent.

See zen.ts:157 for tagging pattern.

## What NOT to Do

❌ Do not execute tools — that's the agent harness's responsibility (agent.ts:252)

❌ Do not handle permissions — that's the agent harness's responsibility (agent.ts:154)

❌ Do not loop after tool calls — that's the agent harness's responsibility (agent.ts:54)

❌ Do not yield harness_start, harness_end, tool_result, or relay events — those are agent harness events

Your provider should make ONE API call per invoke() and yield the raw LLM response as events.

## supportedModels()

Implement this to return the list of model IDs your provider supports. This can be a static list or fetched from the provider's API.

See zen.ts:314 for API-based discovery example.

## Testing

Use the deterministic provider (providers/deterministic.ts) as reference for testing patterns. It yields canned responses without making real API calls.

## Registration

1. Create your provider file in `harness/providers/yourprovider.ts`
2. Export a factory function like `createYourProviderHarness(apiKey?: string)`
3. Export a default instance if you want one
4. Import and use in orchestrator.ts or server code as needed

No central registration needed — harnesses compose at runtime.

## Complete Reference Implementation

See `harness/providers/zen.ts` for the canonical example. It's the simplest and most complete provider implementation:

- Message conversion: zen.ts:34
- Tool conversion: zen.ts:68
- SSE parsing: zen.ts:82
- API call: zen.ts:173
- Event yielding: zen.ts:214-310
- Error handling: zen.ts:182, 193, 214, 270
- Malformed arguments: zen.ts:283
- Model discovery: zen.ts:314

Copy and adapt this structure for new providers.
