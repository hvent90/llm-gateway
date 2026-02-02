# LLM Gateway

Hono server proxying LLM requests through a harness interface.

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

- `server/` - Hono HTTP server & SSE endpoints
- `packages/ai/` - Core AI orchestration package
  - `harness/` - Provider & agent harnesses
  - `tools/` - Tool implementations
  - `client/` - Client-side libraries
  - `primitives/` - Utility structures
- `clients/` - Web and CLI clients
- Tests live in `__tests__/` folders co-located within each module directory (e.g., `tools/__tests__/read.test.ts` for `tools/read.ts`)

## Commands

```bash
bun install
bun run dev
bun test
bun run format
bun run check
```
