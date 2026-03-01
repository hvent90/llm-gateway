# API Reference

## GET /models

Returns available models from the configured harness.

**Response:**

```json
{
  "models": ["model-id-1", "model-id-2"],
  "defaultModel": "model-id-1" // optional, only if configured
}
```

---

## POST /chat

Starts an agent session with SSE streaming.

**Request Body:**

```json
{
  "model": "model-id",
  "messages": [{ "role": "user", "content": "Hello" }],
  "permissions": {
    "allowlist": ["bash", "read"],
    "allowOnce": ["patch"],
    "deny": []
  }
}
```

- `model` (string, required unless defaultModel configured) — model identifier
- `messages` (Message[], required) — conversation history
- `permissions` (Permissions, optional) — permission configuration

**Response:**

Server-Sent Events (SSE) stream with the following event types:

### 1. `event: connected`

First event, always sent. Contains session ID for relay resolution.

```json
{ "type": "connected", "sessionId": "uuid" }
```

### 2. `event: harness_start`

Agent run started.

```json
{ "type": "harness_start", "runId": "uuid", "agentId": "uuid" }
```

### 3. `event: text`

Streamed text content from agent.

```json
{ "type": "text", "id": "uuid", "runId": "uuid", "agentId": "uuid", "content": "..." }
```

### 4. `event: reasoning`

Streamed reasoning content (internal agent thoughts).

```json
{ "type": "reasoning", "id": "uuid", "runId": "uuid", "agentId": "uuid", "content": "..." }
```

### 5. `event: tool_call`

Tool invocation.

```json
{
  "type": "tool_call",
  "id": "uuid",
  "runId": "uuid",
  "agentId": "uuid",
  "name": "bash",
  "input": { "command": "ls" }
}
```

### 6. `event: tool_result`

Tool execution result.

```json
{
  "type": "tool_result",
  "id": "uuid",
  "runId": "uuid",
  "agentId": "uuid",
  "output": "file1.txt\nfile2.txt"
}
```

### 7. `event: repl_input`

REPL code about to execute (RLM harness only).

```json
{
  "type": "repl_input",
  "id": "uuid",
  "runId": "uuid",
  "agentId": "uuid",
  "code": "console.log(context.length)"
}
```

### 8. `event: repl_progress`

Live REPL output during execution (RLM harness only).

```json
{
  "type": "repl_progress",
  "id": "uuid",
  "runId": "uuid",
  "agentId": "uuid",
  "chunk": "512000\n",
  "stream": "stdout"
}
```

### 9. `event: repl_output`

Complete REPL execution result (RLM harness only).

```json
{
  "type": "repl_output",
  "id": "uuid",
  "runId": "uuid",
  "agentId": "uuid",
  "stdout": "512000",
  "done": false
}
```

### 10. `event: relay`

Permission request (agent paused until resolved via POST /chat/relay/:relayId).

```json
{
  "type": "relay",
  "id": "uuid",
  "runId": "uuid",
  "agentId": "uuid",
  "relayId": "uuid",
  "tool": "bash",
  "params": { "command": "rm -rf /" }
}
```

### 8. `event: usage`

Token usage statistics.

```json
{
  "type": "usage",
  "runId": "uuid",
  "agentId": "uuid",
  "inputTokens": 100,
  "outputTokens": 50
}
```

### 9. `event: error`

Error occurred during execution.

```json
{
  "type": "error",
  "runId": "uuid",
  "agentId": "uuid",
  "message": "Error description"
}
```

### 10. `event: harness_end`

Agent run completed.

```json
{ "type": "harness_end", "runId": "uuid", "agentId": "uuid" }
```

**Common Event Fields:**

- `agentId` — always present, identifies the agent producing this event
- `runId` — identifies the conversation turn
- `parentId` — present for subagent events, references parent agent's runId

---

## POST /chat/relay/:relayId

Resolves a pending permission relay to unblock the agent.

**Parameters:**

- `relayId` (path) — relay identifier from the relay event

**Request Body:**

```json
{
  "sessionId": "uuid",
  "response": {
    "approved": true,
    "always": false,
    "reason": "optional denial reason"
  }
}
```

- `sessionId` (string, required) — session ID from the connected event
- `response.approved` (boolean, required) — whether to approve the tool call
- `response.always` (boolean, optional) — if true, adds derived permission to allowlist
- `response.reason` (string, optional) — reason for denial (ignored if approved)

**Response:**

```json
{ "success": true }
```

**Error Responses:**

- `400` — Invalid request body
- `404` — Session or relay not found
