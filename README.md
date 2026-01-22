# LLM Gateway

A lightweight proxy server for LLM API requests.

## Overview

Unified interface for routing requests to multiple LLM providers (OpenAI, Anthropic, etc.) through a harness abstraction. Each harness implements a common interface that yields streaming events, enabling consistent handling regardless of upstream provider.

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
bun run dev    # Start dev server
bun test       # Run tests
bun run format # Format code
bun run check  # Type check
```

## Project Structure

```
src/
├── harnesses/   # Provider implementations
└── ...          # Core server & routing
```

Tests are co-located with source files (`foo.test.ts` next to `foo.ts`).
