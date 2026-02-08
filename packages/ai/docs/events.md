# HarnessEvent Reference

Events that harnesses yield during invocation. See types.ts:77-100 for the full union type.

All events include:
- `runId` — identifies the harness invocation (agent run)
- `parentId?` — links to parent context (e.g., the tool_call ID that spawned a subagent)

## Event Types

### harness_start

Emitted by: Agent harness (harness/agent.ts:46)

Signals the start of an agentic run.

Fields:
- `type: "harness_start"`
- `runId: string`
- `parentId?: string`

### harness_end

Emitted by: Agent harness (harness/agent.ts:115, 245, 313)

Signals completion of an agentic run.

Fields:
- `type: "harness_end"`
- `runId: string`
- `parentId?: string`

### reasoning

Emitted by: Provider harness (zen.ts:238, openai.ts, anthropic.ts)

Streamed reasoning/thinking content from LLM (for models that support it like o1/o3).

Fields:
- `type: "reasoning"`
- `runId: string`
- `id: string` — stable ID for streaming append (same ID for all chunks in a reasoning block)
- `parentId?: string`
- `content: string` — incremental content chunk

### text

Emitted by: Provider harness (zen.ts:249, openai.ts, anthropic.ts)

Streamed text response from LLM.

Fields:
- `type: "text"`
- `runId: string`
- `id: string` — stable ID for streaming append (same ID for all chunks in a text response)
- `parentId?: string`
- `content: string` — incremental content chunk

### tool_call

Emitted by:
- Provider harness (zen.ts:294) — raw tool call from LLM
- Agent harness (harness/agent.ts:203) — after permission check passes

LLM requested a tool call. Agent harness only yields this after permission approval.

Fields:
- `type: "tool_call"`
- `runId: string`
- `id: string` — namespaced by agent (runId/rawId)
- `parentId?: string`
- `name: string` — tool name
- `input: unknown` — parsed tool arguments

### tool_result

Emitted by: Agent harness (harness/agent.ts:268, 186)

Result of tool execution.

Fields:
- `type: "tool_result"`
- `runId: string`
- `id: string` — matches the tool_call ID
- `parentId?: string`
- `name: string` — tool name
- `output: unknown` — result object with `context` and `result` fields, or error

### usage

Emitted by: Provider harness (zen.ts:305)

Token usage statistics from the LLM.

Fields:
- `type: "usage"`
- `runId: string`
- `parentId?: string`
- `inputTokens: number`
- `outputTokens: number`

### error

Emitted by:
- Provider harness (zen.ts:183, 199, 204, 224) — API errors, network errors
- Agent harness (harness/agent.ts:91, 234, 286) — execution errors, tool not found

Error during processing. When yielded by agent harness, it also yields harness_end and stops.

Fields:
- `type: "error"`
- `runId: string`
- `parentId?: string`
- `error: Error`

### relay (kind: "permission")

Emitted by: Agent harness (harness/agent.ts:162)

Permission request that pauses the agent until resolved. The agent harness yields this when a tool call doesn't match allowlist/allowOnce permissions.

Fields:
- `type: "relay"`
- `kind: "permission"`
- `runId: string`
- `id: string` — unique relay ID
- `parentId?: string`
- `toolCallId: string` — the tool_call being gated
- `tool: string` — tool name
- `params: Record<string, unknown>` — tool arguments
- `respond: (response: PermissionResponse) => void` — callback to approve/deny

**Important**: The orchestrator (orchestrator.ts:277) strips the `respond` callback before yielding relay events to consumers. Consumers must use `AgentOrchestrator.resolveRelay()` instead of calling respond directly.

## Event Flow

Provider harness yields:
1. text (streaming)
2. reasoning (streaming, if supported)
3. tool_call (for each tool)
4. usage (once at end)
5. error (if something fails)

Agent harness adds:
1. harness_start (before loop)
2. For each iteration:
   - Calls provider harness → yields text/reasoning/usage/error
   - For each tool_call from provider:
     - Check deny list → tool_result (denied) if denied
     - Check allowlist → relay (permission) if not allowed, wait for response
     - tool_call (approved)
     - tool_result (executed)
3. harness_end (when done or error)

Orchestrator:
- Multiplexes events from all agents
- Pauses agent when relay event is yielded
- Strips respond callback and yields relay to consumer
- Consumer calls resolveRelay() → agent resumes
