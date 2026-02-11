# How RLM Works

Recursive Language Models (RLMs) solve a fundamental problem: LLMs have fixed context windows, but real-world inputs can be arbitrarily long. Instead of cramming the full input into the prompt, an RLM gives the model a **REPL** and a **symbolic handle** to the input. The model writes code to explore, chunk, and process the input programmatically.

## The Core Idea

In a standard LLM call, the input appears directly in the context window:

```
System: You are a helpful assistant.
User: <entire 500KB document here>
      Summarize this document.
```

In an RLM call, the input is a variable in a code environment. The model sees metadata only:

```
System: You have a variable `context` (length: 512000, prefix: "Chapter 1: The Beginning...").
        Write JavaScript to process it.
User: Summarize this document.
```

The model then writes code like:

```js
const chunkSize = 2000;
const summaries = [];
for (let i = 0; i < context.length; i += chunkSize) {
  const summary = await llm_query("Summarize:\n" + context.slice(i, i + chunkSize));
  summaries.push(summary);
}
FINAL(await llm_query("Combine:\n" + summaries.join("\n")));
```

This approach decouples input size from context window size. The model decides how to traverse the data.

## The Inference Loop

The RLM harness implements an iterative loop (analogous to "Algorithm 1" in the RLM paper):

```
┌──────────────────────────────────────────────────────┐
│  1. User prompt → REPL context variable              │
│  2. Build system prompt (metadata only)              │
│                                                      │
│  ┌─── Loop (up to maxIterations) ──────────────────┐ │
│  │  3. Call LLM → get code response                │ │
│  │  4. Extract code from fenced block              │ │
│  │  5. Execute code in sandboxed REPL              │ │
│  │  6. Feed stdout/error back as next user message │ │
│  │                                                 │ │
│  │  If FINAL() called → emit answer, break         │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  7. Emit harness_end                                 │
└──────────────────────────────────────────────────────┘
```

Each iteration is one "REPL turn." The model sees previous turns' outputs in its message history, so it can iteratively refine its approach — inspect the data, try a strategy, handle errors, and converge on an answer.

## The REPL Environment

The REPL (`repl.ts`) provides a sandboxed async JavaScript execution environment:

### Built-in variables and functions

| Name | Type | Description |
|------|------|-------------|
| `context` | `string` | The user's input, available as a plain JS string |
| `llm_query(prompt)` | `(string) => Promise<string>` | Send a prompt to a sub-agent with its own REPL and iteration loop. The prompt becomes the sub-agent's `context`. At depth 0, falls back to a flat one-shot call. |
| `exec(command, timeout?)` | `(string, number?) => Promise<ShellResult>` | Execute a shell command. Returns `{ stdout, stderr, exitCode }`. Default timeout: 10s |
| `FINAL(answer)` | `(unknown) => void` | Emit a value as the final answer and stop the loop |
| `FINAL_VAR(varName)` | `(string) => void` | Emit a scope variable as the final answer and stop |
| `print(...args)` / `console.log` | `(...unknown[]) => void` | Print to stdout (shown back to model) |

### Persistence

Variables persist across REPL turns through a shared `scope` object. The model assigns values as `scope.varName = value`, and they survive between `execute()` calls. Built-ins (`context`, `llm_query`, `exec`, etc.) are also in scope but exposed as convenience locals via destructuring.

### Sandboxing

Code runs via `AsyncFunction` (the async equivalent of `new Function()`). The REPL does not explicitly provide `process`, `require`, or other Node/Bun globals. Stdout is captured through a replaced `console` object and `print()` function, then truncated to `maxStdoutLength`.

### Error handling

Runtime errors and syntax errors are caught and returned in the `ReplExecutionResult.error` field. The REPL does not crash — subsequent turns continue normally. Stdout captured before the error is preserved.

## Symbolic Handles

The term "symbolic handle" describes the key design choice: the model never receives the full input in its context window. Instead, it receives:

- **Length**: how many characters the input has
- **Prefix**: a short prefix snippet for orientation

The model must use code to access the actual data via the `context` variable. This is what makes RLM recursive — the model can delegate parts of `context` to `llm_query` calls, each of which spawns a child RLM session with its own REPL and iteration loop. Each child processes a slice without any single call needing to fit the whole input.

## How It Fits Into the Harness Architecture

The RLM harness implements `GeneratorHarnessModule` — the same interface as provider harnesses (zen, anthropic, openai, etc.). This means it composes with the rest of the system:

```
┌─────────────────────────────────────────────────────────┐
│ Agent Harness (agentic loop, tools, permissions)        │
│   └─ RLM Harness (REPL loop, code extraction)          │
│       ├─ Root Provider (LLM calls for code generation)  │
│       └─ Sub Provider (LLM calls for llm_query)         │
└─────────────────────────────────────────────────────────┘
```

- **RLM as provider**: The RLM harness slots in where a provider harness would go. It receives `invoke(params)` and yields `HarnessEvent`s.
- **Two providers inside**: The RLM harness uses a `rootHarness` for the code-generating LLM calls (the model that writes REPL code) and an optional `subHarness` for `llm_query` calls inside the REPL (often a cheaper/faster model).
- **Event compatibility**: The RLM harness yields the same event types as any provider — `harness_start`, `tool_call`, `tool_result`, `text`, `usage`, `harness_end`. Clients render RLM sessions identically to agent tool calls.

## Event Flow

For a two-turn RLM session:

```
harness_start (runId: "r1")
  ↓
usage (from first LLM call)
  ↓
tool_call (name: "repl_execute", input: { code: "print(context.length)" })
  ↓
tool_result (output: { stdout: "512000" })
  ↓
usage (from second LLM call)
  ↓
tool_call (name: "repl_execute", input: { code: "FINAL('large document')" })
  ↓
tool_result (output: { stdout: "" })
  ↓
text (content: "large document")    ← the final answer
  ↓
harness_end (runId: "r1")
```

All events share the same `runId`. The `tool_call`/`tool_result` pairs make each REPL turn visible to clients, so UIs can show the model's code and its output as the session progresses.

## Design Decisions

**Why JavaScript instead of a custom DSL?** Real JavaScript gives the model access to string manipulation, loops, array methods, async/await, and error handling without inventing a language. LLMs are already fluent in JavaScript.

**Why metadata-only system prompt?** If the model saw the full input, RLM would offer no advantage over a standard LLM call. The metadata-only approach forces the model to use code, which is the whole point.

**Why separate root and sub models?** The code-generating model needs to be capable (it's writing programs), but `llm_query` calls inside the REPL are typically simpler tasks (summarize a chunk, extract a field). Using a cheaper model for sub-calls reduces cost.

**Why depth-limited recursion?** `llm_query` spawns a full child RLM session at depth > 0 and falls back to a flat one-shot call at depth 0. The `maxDepth` config (default: 2) controls this. Each child inherits the parent's config with `maxDepth` decremented. This gives the model recursive capability while preventing unbounded nesting.
