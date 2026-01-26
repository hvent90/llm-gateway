# LLM Gateway

Opinionated work-in-progress implementation of an agent harness and the gateway to deliver LLM requests.

## Core Principles

- Simple agent `while-loop` that streams events
- An individual agent's events can be paused (ex: human-in-the-loop, tool call permissions) without affecting any other streams
- Events naturally form a directed acyclic graph
- Expose "power-user"-esque interactions for managing a conversation:
  - the user can interact with any message (including subagents before, during, and after their execution) 
  - any message can be branched any amount of times
  - multi-select messages and tool calls to:
    - remove from context window
    - compact via separate LLM call
    - edit
    - ...future requirements
- Subagents can be resurrected or queried even after they are finished
- The message history should go through a reducer with middlewares, the result being the final context given to the agent.

## Why is this being made

I want an agent framework that I am intimately familiar with, is made of simple primitives that can be extended easily, and fills current UX gaps with how a user interacts with an agent.

If all goes well, this is what will happen:
- it will be the agent framework that powers all future LLM requirements across all of my projects
- I will build a set of core interaction principles and then ship PRs to the popular agent frameworks that introduce those principles to their UX.

## Stack

- **Bun** - Runtime & package manager
- **Hono** - Web framework
- **Effect** - Error handling & retries

## Setup

```bash
bun install
cp .env.development .env
```

Configure your provider API keys in `.env`.

## Development

```bash
bun run dev:server  # Start dev server
bun run dev:web     # Start web client (Vite)
bun run dev:cli     # Run CLI client
bun test            # Run tests
bun run format      # Format code (oxfmt)
```