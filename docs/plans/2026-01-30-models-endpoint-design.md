# GET /models Endpoint

## Summary

Add a `GET /models` endpoint that returns the list of models supported by the server's configured harness. The client already sends `model` in chat requests and it flows through to the provider — this endpoint lets clients discover what models are available.

## Endpoint

`GET /models`

### Response

```json
{ "models": ["model-a", "model-b", "model-c"] }
```

## Implementation

### Changes

1. **`server/index.ts`** — resolve the harness once at app creation, add `GET /models` route that calls `harness.supportedModels()`
2. **`server/__tests__/models.test.ts`** — test the endpoint using a deterministic harness

### Detail

The orchestrator already resolves a default harness (`createAgentHarness({ harness: createGeneratorHarness() })`). Rather than duplicating that logic, resolve the harness module once at `createApp` time and share it between the orchestrator and the models route.

The agent harness delegates `supportedModels()` to the wrapped provider harness, so calling it on the agent harness returns the correct provider model list.
