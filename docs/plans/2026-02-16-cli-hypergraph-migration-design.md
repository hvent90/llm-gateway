# CLI Client Hypergraph Migration

## Problem

The CLI client (`clients/cli/index.tsx`) imports `getRoots`, `getChildren`, `getContentBlocks`, `getRole` from the legacy graph model — functions that don't exist in the client exports. The client is broken. The web client has already migrated to the hypergraph SDK.

## Approach

Port the CLI to use the same hypergraph imports and `projectThread()` rendering that the web client uses. The conversation state management (`reduceConversation`, `createInitialConversation`) already has the same API; only the rendering and message-building layers change.

## Changes

### Imports

Replace legacy graph imports with hypergraph equivalents:

- `createInitialConversation`, `reduceConversation` → from `packages/ai/client/hypergraph`
- `projectThread`, `projectMessages` → from `packages/ai/client/hypergraph`
- `createSSETransport`, `createHTTPTransport` → from `packages/ai/client` (unchanged)
- Types: `ConversationState`, `PendingRelay` from hypergraph; `ViewNode`, `ViewContent` from hypergraph

### Rendering

Replace `NodeView` (recursive graph walker) with a flat `ThreadView` that renders `projectThread(graph) → ViewNode[]`:

- Group ViewNodes by `runId` (same `groupNodes` pattern as web client)
- Render each `ViewContent.kind`: `text`, `reasoning`, `tool_call`, `error`, `relay`, `user`, `pending`
- Render `node.branches` as indented subagent sections using terminal padding
- Streaming indicator via `node.status === "streaming"`

### Message building

Replace custom `buildApiMessages()` with `projectMessages(graph)` from the SDK.

### What stays the same

- SolidJS + @opentui/solid rendering framework
- Transport layer
- Relay resolution flow (y/n terminal input)
- Status bar, input handling, streaming lifecycle

## Rendering mapping

| Web | CLI |
|---|---|
| `projectThread(graph)` → `groupNodes` | Same |
| `ContentView` switch on `content.kind` | `ContentView` switch on `content.kind` |
| `BranchView` with CSS left-border | `BranchView` with `paddingLeft` + `borderLeft` |
| `ToolCallView` collapsible | Show name + truncated params + output |
| `PermissionPromptInline` buttons | Text prompt: "Enter 'y'/'n'" |
