# Default Model Configuration

## Problem

Every chat request requires selecting a model from the dropdown. When working with a preferred model, this is friction -- the server should support a configured default.

## Design

Single `DEFAULT_MODEL` env var at the server level. The server validates it against the harness's supported models and communicates it to the frontend via `GET /models`.

### Server changes

**`AppConfig`** gains `defaultModel?: string`. Production reads `process.env.DEFAULT_MODEL`.

**`GET /models`** returns `{ models: string[], defaultModel?: string }`. The `defaultModel` field is only included if the configured value is present in the harness's `supportedModels()` list (silently omitted otherwise).

**`POST /chat`** falls back to `defaultModel` when `body.model` is empty/missing. Returns 400 if no model is resolved (neither provided nor configured).

### Frontend changes

The `/models` fetch reads `data.defaultModel` and uses it for initial `selectedModel`. Falls back to first model in list if no default is set (current behavior).

### Tests

- `GET /models` returns `defaultModel` when it matches a supported model
- `GET /models` omits `defaultModel` when not in supported list
- `POST /chat` uses `defaultModel` when `model` is omitted from request
- `POST /chat` returns 400 when no model provided and no default configured
