# Folder Reorganization Tasks

Sequential tasks for restructuring the LLM Gateway codebase.

## Tasks

- [ ] **1. Create directory structure**
  - Create `packages/ai/harness/`
  - Create `clients/cli/`
  - Create `server/`

- [ ] **2. Move types**
  - Move `src/types.ts` → `packages/ai/types.ts`

- [ ] **3. Move harnesses**
  - Move `src/harnesses/openrouter.ts` → `packages/ai/harness/openrouter.ts`
  - Move `src/harnesses/agent.ts` → `packages/ai/harness/agent.ts`

- [ ] **4. Relocate tool execution**
  - Move the `tool.execute()` call logic from `agent.ts` into `openrouter.ts`
  - `agent.ts` handles only the agentic loop, `openrouter.ts` handles execution

- [ ] **5. Co-locate tests**
  - Move `src/harnesses/tests/openrouter.test.ts` → `packages/ai/harness/openrouter.test.ts`
  - Move `src/harnesses/tests/agent.test.ts` → `packages/ai/harness/agent.test.ts`

- [ ] **6. Create CLI client stub**
  - Create `clients/cli/index.ts` with intent documentation
  - Purpose: OpenTUI client for interfacing with server, displays main and subagent events

- [ ] **7. Initialize Hono server**
  - Create `server/index.ts` with Hono server
  - Single `POST /chat` endpoint
  - Streaming SSE responses
  - Calls openrouter harness (no caching, no message persistence)

- [ ] **8. Cleanup**
  - Delete root `index.ts`
  - Delete empty `src/harnesses/` directory
  - Update all import paths

- [ ] **9. Verify**
  - Run `bun run check` for type checking
  - Run `bun test` to ensure tests pass
  - Update `package.json` scripts if needed
