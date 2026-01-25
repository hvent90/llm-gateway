# Requirements

## Overview

LLM Gateway proxies LLM requests through a harness interface, with durable streaming and conversation persistence.

## Streaming Architecture

### In-Flight Caching

- Use Redis Streams (`XADD`) to cache in-flight chunks
- Stream key: `stream:conversation:{conv_id}:message:{msg_id}`
- TTL: 10 minutes
- Each LLM invocation = 1 Redis stream = 1 DB row

### Client Resume

- Clients can reconnect mid-stream
- Use `XREAD` from last seen ID to resume
- Historical chunks delivered up to reconnection point

### Stream Lifecycle

| Event   | Action                                          |
| ------- | ----------------------------------------------- |
| Success | Persist message to Postgres, flush Redis stream |
| Failure | Discard partial response, flush Redis stream    |

## Persistence

### Database

- Postgres
- Gateway handles DB writes
- User messages go straight to DB (no streaming)

### Message Schema

```
messages:
  id
  conversation_id
  agent_id
  parent_message_id  -- nullable for root, defines graph edges
  role
  content
  created_at
```

### Conversation Structure

- Messages form a directed graph via `parent_message_id`
- Client receives tree structure
- Agent hierarchy derived from message graph

## Agents

### Agent Identity

- `agent_id` tied to harness invocation
- Shared across all messages from the same agent instance
- Subagents are first-class citizens with their own `agent_id`

### Fault Isolation

- Each message has its own Redis stream
- Subagent failure does not affect parent agent's stream
- Independent success/failure lifecycle per message

## Conversation Retrieval

- Gateway responsible for merging DB + Redis
- Completed messages from Postgres
- In-flight messages from Redis
- Returns tree structure to client
