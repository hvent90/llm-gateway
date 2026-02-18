# CLI Hypergraph Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the CLI client from broken legacy graph imports to the hypergraph SDK, achieving full thread parity with the web client.

**Architecture:** Replace legacy graph traversal (`getRoots`/`getChildren`/`getContentBlocks`/`getRole`) with `projectThread()` → `ViewNode[]` flat rendering. Replace custom `buildApiMessages()` with `projectMessages()`. Keep SolidJS + @opentui/solid rendering.

**Tech Stack:** SolidJS, @opentui/solid, packages/ai/client/hypergraph

---

### Task 1: Update imports and types

**Files:**
- Modify: `clients/cli/index.tsx:1-23`

**Step 1: Replace imports**

Change the import block from:

```tsx
import {
  createSSETransport,
  createHTTPTransport,
  createInitialConversation,
  reduceConversation,
  getRoots,
  getChildren,
  getContentBlocks,
  getRole,
} from "../../packages/ai/client";
import type { ConversationState, ContentBlock, PendingRelay } from "../../packages/ai/client";
```

To:

```tsx
import {
  createSSETransport,
  createHTTPTransport,
} from "../../packages/ai/client";
import {
  createInitialConversation,
  reduceConversation,
  projectThread,
  projectMessages,
} from "../../packages/ai/client/hypergraph";
import type { ConversationState, PendingRelay } from "../../packages/ai/client/hypergraph";
import type { ViewNode, ViewContent } from "../../packages/ai/client/hypergraph";
```

**Step 2: Verify the file saves without syntax errors**

Run: `bun build --no-bundle clients/cli/index.tsx --outdir /tmp/cli-check 2>&1 | head -5`

This will still have errors from removed functions being used below — that's expected. We just confirm the import lines themselves parse.

**Step 3: Commit**

```bash
git add clients/cli/index.tsx
git commit -m "refactor(cli): update imports from legacy graph to hypergraph SDK"
```

---

### Task 2: Replace rendering components

**Files:**
- Modify: `clients/cli/index.tsx:38-137` (BlockView, getErrorMessages, NodeView)

**Step 1: Replace `BlockView`, `getErrorMessages`, and `NodeView` with `ContentView`, `BranchView`, and `ThreadView`**

Delete the old `BlockView` (lines 46-87), `getErrorMessages` (lines 89-94), and `NodeView` (lines 97-137).

Replace with these three components:

```tsx
// Render a single ViewContent item
function ContentView(props: { content: ViewContent; isUser: boolean }) {
  switch (props.content.kind) {
    case "user":
      return (
        <text wrapMode="word">
          {"You: "}
          {typeof props.content.content === "string"
            ? props.content.content
            : props.content.content
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("\n")}
        </text>
      );
    case "text":
      return <text wrapMode="word">{props.content.text.trimEnd()}</text>;
    case "reasoning":
      return (
        <box paddingLeft={2} borderLeft borderColor="gray">
          <text
            wrapMode="word"
            fg="gray"
            attributes={createTextAttributes({ dim: true, italic: true })}
          >
            {props.content.text.trimEnd()}
          </text>
        </box>
      );
    case "tool_call": {
      const inputStr =
        typeof props.content.input === "string"
          ? props.content.input
          : JSON.stringify(props.content.input);
      const outputStr =
        props.content.output !== undefined ? formatOutput(props.content.output) : null;
      return (
        <box>
          <text wrapMode="word">{`[tool] ${props.content.name}: ${inputStr}`}</text>
          <Show when={outputStr !== null}>
            <text wrapMode="word">{`   -> ${outputStr}`}</text>
          </Show>
        </box>
      );
    }
    case "error":
      return (
        <text wrapMode="word" fg="red">
          {`[error] ${props.content.message}`}
        </text>
      );
    case "relay":
      return (
        <box marginTop={1}>
          <text wrapMode="word" fg="yellow">
            {`[!] Permission Required\n   Tool: ${props.content.tool}\n   Params: ${JSON.stringify(props.content.params, null, 2)}\n   Enter 'y' to allow, 'n' to deny`}
          </text>
        </box>
      );
    case "pending":
      return (
        <text wrapMode="word" fg="gray">
          {"..."}
        </text>
      );
  }
}

// Render a subagent branch (indented)
function BranchView(props: { nodes: ViewNode[]; pendingRelays: PendingRelay[] }) {
  return (
    <Show when={props.nodes.length > 0}>
      <box marginLeft={2} borderLeft borderColor="gray" paddingLeft={1} marginTop={1}>
        <text fg="green" attributes={createTextAttributes({ dim: true })}>
          {`agent-${props.nodes[0]!.runId.replace(/-/g, "").slice(-7)}`}
        </text>
        <ThreadView nodes={props.nodes} pendingRelays={props.pendingRelays} />
      </box>
    </Show>
  );
}

// Render the flat ViewNode[] thread
function ThreadView(props: { nodes: ViewNode[]; pendingRelays: PendingRelay[] }) {
  return (
    <For each={props.nodes}>
      {(node) => (
        <box marginTop={node.role === "user" ? 1 : 0} marginBottom={node.role === "user" ? 1 : 0}>
          <ContentView content={node.content} isUser={node.role === "user"} />
          <For each={node.branches}>
            {(branch) => <BranchView nodes={branch} pendingRelays={props.pendingRelays} />}
          </For>
        </box>
      )}
    </For>
  );
}
```

**Step 2: Commit**

```bash
git add clients/cli/index.tsx
git commit -m "refactor(cli): replace legacy NodeView with hypergraph ThreadView"
```

---

### Task 3: Replace message building and update ChatApp

**Files:**
- Modify: `clients/cli/index.tsx` (buildApiMessages function + ChatApp component)

**Step 1: Delete `buildApiMessages` function**

Delete the entire `buildApiMessages` function (lines ~140-173). It's replaced by `projectMessages(graph)` from the SDK.

**Step 2: Update ChatApp to use new rendering**

In `ChatApp`, replace:

```tsx
const roots = () => getRoots(conversation().graph);
```

With:

```tsx
const viewNodes = () => projectThread(conversation().graph);
```

Replace the messages area JSX (the `<scrollbox>` content) from:

```tsx
<Show when={roots().length === 0}>
  <text wrapMode="word">Welcome! Type a message and press Enter to start chatting.</text>
</Show>
<For each={roots()}>
  {(runId) => (
    <NodeView
      graph={conversation().graph}
      runId={runId}
      pendingRelays={conversation().pendingRelays}
    />
  )}
</For>
```

To:

```tsx
<Show when={viewNodes().length === 0}>
  <text wrapMode="word">Welcome! Type a message and press Enter to start chatting.</text>
</Show>
<ThreadView nodes={viewNodes()} pendingRelays={conversation().pendingRelays} />
```

**Step 3: Update `handleSubmit` to use `projectMessages`**

Replace:

```tsx
const apiMessages = buildApiMessages(conversation().graph);
```

With:

```tsx
const apiMessages = [
  ...projectMessages(conversation().graph),
  { role: "user" as const, content: userInput },
];
```

Note: We add the latest user message manually because `reduceConversation` was just called with the user event, but `projectMessages` needs to include it. Actually, let me check — we call `setConversation` with the user event first, then read `conversation().graph`. In SolidJS, `setConversation` is synchronous, so `conversation().graph` already includes the user message. So we should just use:

```tsx
const apiMessages = projectMessages(conversation().graph);
```

This matches the web client pattern (web does `[...projectMessages(current.graph), { role: "user" as const, content }]` but reads from `stateRef.current` which is stale — the CLI's SolidJS signals are synchronous so `conversation().graph` is already updated).

Wait — looking at the web client more carefully at `App.tsx:110-112`:
```tsx
setState((s) => reduceConversation(s, { type: "user", runId: userId, content }));
const current = stateRef.current;
const messages = [...projectMessages(current.graph), { role: "user" as const, content }];
```

The web client uses `stateRef.current` which IS updated (via the ref sync at line 30). So it gets the graph with the user message, then still appends the user message — that's a bug in the web client (double user message). But we should follow the correct pattern.

In SolidJS, after `setConversation(...)`, calling `conversation()` returns the updated state. So the user message is already in the graph. Use:

```tsx
const apiMessages = projectMessages(conversation().graph);
```

**Step 4: Remove the `pendingRelay` relay rendering from inside `handleSubmit`**

The relay prompts are now rendered inline by `ContentView` when it encounters `kind: "relay"` ViewContent nodes. But the CLI still needs to handle relay y/n input. The existing `pendingRelay()` signal and relay resolution logic in `handleSubmit` stays as-is — it reads from `conversation().pendingRelays` which is managed by `reduceConversation`.

**Step 5: Commit**

```bash
git add clients/cli/index.tsx
git commit -m "refactor(cli): use projectThread/projectMessages from hypergraph SDK"
```

---

### Task 4: Verify the build compiles

**Files:**
- Verify: `clients/cli/index.tsx`

**Step 1: Run the build check**

Run: `bun build --no-bundle clients/cli/index.tsx --outdir /tmp/cli-check 2>&1`

Expected: No errors. If there are type errors, fix them.

**Step 2: Run formatter**

Run: `bun run format`

**Step 3: Commit any format changes**

```bash
git add clients/cli/index.tsx
git commit -m "style(cli): format after hypergraph migration"
```

---

### Task 5: Update CLI CLAUDE.md

**Files:**
- Modify: `clients/cli/CLAUDE.md`

**Step 1: Update the documentation**

The CLAUDE.md currently references `reduceConversation`, `projectThread`, transports from `packages/ai/client`. Update to reference the correct import paths now that the CLI uses `packages/ai/client/hypergraph` for state management and projections:

```markdown
# CLI Client

## WHY

Terminal-based chat client with rich TUI rendering. Uses SolidJS fine-grained reactivity for efficient streaming updates without full redraws.

## WHAT

**Single file:** `index.tsx` (~300 lines)

**Stack:** SolidJS + @opentui/solid (optional peer dependency)

Three components: `ChatApp` (state management + layout), `ThreadView` (flat thread renderer using `projectThread()`), `ContentView` (ViewContent kind renderer). Uses SolidJS fine-grained reactivity so streaming updates re-render only changed DOM nodes. Subagent branches rendered via `BranchView` with terminal indentation.

Uses `reduceConversation`, `projectThread`, `projectMessages` from `packages/ai/client/hypergraph`, and transports from `packages/ai/client`.

## HOW

\`\`\`bash
bun run dev:cli  # needs .env with API key
\`\`\`

**Config:** SERVER_URL and DEFAULT_MODEL from environment.
```

**Step 2: Commit**

```bash
git add clients/cli/CLAUDE.md
git commit -m "docs(cli): update CLAUDE.md for hypergraph migration"
```
