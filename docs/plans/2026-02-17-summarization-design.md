# Summarization POC Design

## Problem

Long conversations accumulate context that exceeds token limits or becomes noisy. Users need a way to select a subset of messages and replace them with a concise summary.

## Approach

New `POST /summarize` endpoint. Client sends message content and source IDs. Server makes a single LLM call with a summarization prompt. Client wires the result into the hypergraph using existing `operations.summarize()`.

## API

### `POST /summarize` (SSE stream)

Request:
```typescript
{
  model: string;
  messages: Message[];   // Content to summarize (from deriveMessageContent)
  sourceIds: string[];   // Message node IDs (echoed back for graph wiring)
}
```

Response: SSE stream — `text` chunks, `usage`, `harness_start`/`harness_end`. No tools, no relay, no agent loop.

## Server

Single provider harness invocation (not agent harness). System prompt instructs the LLM to summarize. The messages array is formatted into the user prompt. Standard harness events stream back.

## Client

After stream completes:
1. Collect text events into summary string
2. Create message node with summary text
3. Call `operations.summarize(graph, active, sourceIds, summaryNode)`
4. Summary replaces originals in active set; expand/collapse works via existing operations

## Not in scope

- Persistence (summary lives only in client graph)
- Custom prompt control
- Partial summarization (e.g., tool outputs only)
