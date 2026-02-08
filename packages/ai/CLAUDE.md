# packages/ai

Core orchestration engine for multi-agent AI systems. Provides composable harnesses that yield events, an orchestrator for managing concurrent agents, and async primitives for coordination.

## Architecture

This package implements a harness interface where LLM providers yield events through async generators. Agent harnesses wrap provider harnesses to add tool execution and permission checking. The orchestrator multiplexes multiple agent streams concurrently.

## Key Modules

### Core Orchestration
- `orchestrator.ts:81` — AgentOrchestrator: spawns agents, multiplexes events, manages relay flow (permission requests from agents to clients)
- `multiplexer.ts:37` — AgentMultiplexer: races multiple async iterables via Promise.race, supports pause/resume per agent
- `types.ts:77-100` — HarnessEvent: union type of all events (harness_start, text, reasoning, tool_call, tool_result, usage, error, relay)
- `types.ts:134` — GeneratorHarnessModule: the harness interface (`invoke()` returns `AsyncIterable<HarnessEvent>`)

### Tool & Permission System
- `permissions.ts:9` — matchesPermission: glob pattern matching for tool parameters
- `skills.ts:24` — discoverSkills: scans directories for SKILL.md files with frontmatter
- `tools/` — Built-in tool implementations (bash, read, patch, agent spawning)

### Subsystems
- `harness/` — Agent and provider harness implementations
- `client/` — Client-side state management (graph, projections, transports)
- `primitives/` — Async coordination primitives (deferred, async-queue, passthrough)
- `logger.ts:22` — Structured logging with ENOENT recovery

## How It Works

Provider harnesses (harness/providers/) make single LLM calls and yield: text, reasoning, tool_call, usage, error events.

Agent harness (harness/agent.ts:30) wraps a provider to add:
- Agentic loop (continues until no tool calls or maxIterations)
- Permission checking via deferred promises (yields relay events, pauses until resolved)
- Concurrent tool execution via Promise.all
- Message history accumulation
- Adds: harness_start, harness_end, tool_result events

The orchestrator creates agent harnesses and multiplexes their event streams. When an agent needs permission, it yields a relay event and pauses. The orchestrator strips the respond callback, stashes it, and yields the relay to consumers. Consumers call resolveRelay() to approve/deny and resume the agent.

## Testing

Tests co-located with source or in `__tests__/` folders. Use deterministic provider (harness/providers/deterministic.ts) for testing.

## Docs

- `docs/events.md` — HarnessEvent type reference
- Root `docs/subagents.md` — Subagent architecture
- Root `docs/requirements.md` — Streaming and persistence requirements
