# LLM Gateway

An agent framework built on three simple ideas: a harness yields events, harnesses compose, and events form a graph.

## Tech Stack

| Tool   | Purpose                   |
| ------ | ------------------------- |
| Bun    | Runtime & package manager |
| Hono   | Web framework             |
| Effect | Error handling & retries  |
| oxfmt  | Formatting                |

## Development Principles

- TDD with failure loops - write failing test first, then implement
- Tests must only output on failure (quiet success, loud failure)
- No mocks - use real integrations in tests
- Refactor freely, no backwards compatibility shims
- No re-export shims - when code moves, update all import sites to point to the new location instead of leaving behind proxy re-exports
- Ask questions early - liberally use AskUserQuestion when requirements are unclear or ambiguous

## Project Structure

Each module has its own CLAUDE.md with deeper context.

- `server/` - Hono HTTP server & SSE endpoints
- `packages/ai/` - Core AI orchestration package
  - `harness/` - Provider & agent harnesses (async generators that yield events)
  - `tools/` - Tool implementations
  - `client/` - Client-side libraries
  - `primitives/` - Utility structures
- `clients/` - Web and CLI clients
- Tests co-located with source files or in adjacent `__tests__/` folders

## Docs

- `docs/subagents.md` - Subagent spawning, graph structure, and client rendering
- `docs/requirements.md` - Streaming architecture, persistence, and conversation graph
- `docs/writing-a-good-claude-md.md` - Guidelines for writing effective CLAUDE.md files

## Commands

```bash
bun install
bun run dev
bun test
bun run format
```
