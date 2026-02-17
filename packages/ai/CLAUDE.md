# packages/ai

Core orchestration engine for multi-agent AI systems. Provides composable harnesses that yield events, an orchestrator for managing concurrent agents, and async primitives for coordination.

## Architecture

This package implements a harness interface where LLM providers yield events through async generators. Agent harnesses wrap provider harnesses to add tool execution and permission checking. The orchestrator multiplexes multiple agent streams concurrently.

## Key Modules

- `orchestrator.ts` — AgentOrchestrator: spawns agents, multiplexes events, manages relay flow
- `multiplexer.ts` — AgentMultiplexer: races multiple async iterables, supports pause/resume
- `types.ts` — HarnessEvent union type and GeneratorHarnessModule interface
- `permissions.ts` — Glob pattern matching for tool permission rules
- `skills.ts` — Discovers SKILL.md files with frontmatter for agent skills
- `tools/` — Built-in tool implementations (bash, read, patch, agent spawning)
- `harness/` — Agent and provider harness implementations
- `client/` — Client-side state management (graph, projections, transports). The `hypergraph/` submodule is the active graph model (3-tier chunk→block→message nodes with typed hyperedges).
- `primitives/` — Async coordination primitives (deferred, async-queue, passthrough)

## How It Works

Provider harnesses make single LLM calls and yield events (text, reasoning, tool_call, usage, error). The agent harness wraps a provider to add an agentic loop with tool execution, permission checking via relay events, and message history. The orchestrator multiplexes agent streams and mediates relay flow between agents and consumers.

## Testing

Tests co-located with source or in `__tests__/` folders. Use deterministic provider (harness/providers/deterministic.ts) for testing.

## Docs

- Root `docs/events.md` — HarnessEvent type reference
- Root `docs/subagents.md` — Subagent architecture
- Root `docs/requirements.md` — Streaming and persistence requirements
