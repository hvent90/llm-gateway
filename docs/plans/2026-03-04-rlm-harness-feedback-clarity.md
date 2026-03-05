# RLM Harness Feedback Clarity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make harness feedback unambiguous to LLMs by wrapping output in XML tags, rejecting malformed responses, and updating the system prompt.

**Architecture:** Four changes to two files — `extractCode` validation in harness.ts, XML-wrapped feedback in harness.ts, system prompt updates in system-prompt.ts, and test updates.

**Tech Stack:** Bun, TypeScript

---

### Task 1: Strict extractCode — reject multi-block and post-fence text

**Files:**
- Modify: `packages/ai/rlm/harness.ts:30-35`
- Test: `packages/ai/rlm/__tests__/harness.test.ts`

**Step 1: Write failing tests**

Add to the `multiple code blocks` describe block and add a new `post-fence text` describe block:

```ts
describe("multiple code blocks", () => {
  test("model returning multiple code blocks gets error feedback and can recover", async () => {
    // ... existing test stays as-is ...
  });

  test("error message specifies the number of blocks found", async () => {
    const rootHarness = createDeterministicHarness({
      model: "deterministic",
      responses: [
        {
          events: [
            {
              type: "text",
              content: '```js\nconsole.log("a")\n```\n```js\nconsole.log("b")\n```\n```js\nconsole.log("c")\n```',
            },
          ],
        },
        { events: [{ type: "text", content: fence('FINAL("ok")') }] },
      ],
    });

    const rlm = createRlmHarness({
      rootHarness,
      config: defaultConfig(),
    });

    const events = await collectEvents(
      rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    if (errors[0].type === "error") {
      expect(errors[0].error.message).toContain("3 code blocks");
    }
  });
});

describe("post-fence text", () => {
  test("text after closing fence is rejected with error", async () => {
    const rootHarness = createDeterministicHarness({
      model: "deterministic",
      responses: [
        {
          events: [
            {
              type: "text",
              content: '```js\nFINAL("hello")\n```\nHere is what I found in the file:\nconst x = 1;',
            },
          ],
        },
        { events: [{ type: "text", content: fence('FINAL("recovered")') }] },
      ],
    });

    const rlm = createRlmHarness({
      rootHarness,
      config: defaultConfig(),
    });

    const events = await collectEvents(
      rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
    );

    // Should reject the first response
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    if (errors[0].type === "error") {
      expect(errors[0].error.message).toContain("after closing code fence");
    }

    // No repl_input for the rejected turn
    const replInputs = events.filter((e) => e.type === "repl_input");
    expect(replInputs.length).toBe(1);

    // Should recover
    const finalText = findFinalText(events);
    expect(finalText).toBe("recovered");
  });

  test("reasoning before code block is allowed", async () => {
    const rootHarness = createDeterministicHarness({
      model: "deterministic",
      responses: [
        {
          events: [
            {
              type: "text",
              content: 'Let me think about this step by step.\n\n```js\nFINAL("works")\n```',
            },
          ],
        },
      ],
    });

    const rlm = createRlmHarness({
      rootHarness,
      config: defaultConfig(),
    });

    const events = await collectEvents(
      rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(0);

    const finalText = findFinalText(events);
    expect(finalText).toBe("works");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: `error message specifies the number of blocks found` FAILS (current code silently concatenates). `text after closing fence is rejected` FAILS (current code accepts it). `reasoning before code block is allowed` should PASS already.

**Step 3: Implement extractCode changes**

In `packages/ai/rlm/harness.ts`, replace lines 29-35:

```ts
/** Extract code from a model response. Requires exactly one fenced JS block with no trailing text. */
function extractCode(text: string): string {
  const fenceRe = /```(?:js|javascript)\n([\s\S]*?)```/g;
  const matches = [...text.matchAll(fenceRe)];
  if (matches.length === 0)
    throw new Error("No code block found. Respond with exactly one ```js block.");
  if (matches.length > 1)
    throw new Error(
      `Found ${matches.length} code blocks. Respond with exactly one \`\`\`js block per turn.`,
    );

  const match = matches[0];
  const endIndex = match.index! + match[0].length;
  const trailing = text.slice(endIndex).trim();
  if (trailing.length > 0)
    throw new Error(
      "Text found after closing code fence. Do not write anything after the closing ```. All reasoning must come before the code block.",
    );

  return match[1].trim();
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/ai/rlm/harness.ts packages/ai/rlm/__tests__/harness.test.ts
git commit -m "feat(rlm): reject multi-block and post-fence text in extractCode"
```

---

### Task 2: XML-wrapped REPL output and extraction errors

**Files:**
- Modify: `packages/ai/rlm/harness.ts:457-458,512-516`
- Test: `packages/ai/rlm/__tests__/harness.test.ts`

**Step 1: Write failing tests**

Add a new `feedback format` describe block:

```ts
describe("feedback format", () => {
  test("REPL output is wrapped in harness:repl_output XML tags", async () => {
    const rootHarness = createDeterministicHarness({
      model: "deterministic",
      responses: [
        { events: [{ type: "text", content: fence("console.log('hello')") }] },
        { events: [{ type: "text", content: fence('FINAL("done")') }] },
      ],
    });

    const rlm = createRlmHarness({
      rootHarness,
      config: defaultConfig(),
    });

    // Access internal messages by inspecting the second LLM call's messages
    // We can verify via the deterministic harness's recorded calls
    const events = await collectEvents(
      rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
    );

    // Verify via the deterministic harness — the second call should have XML-wrapped feedback
    const calls = rootHarness.recordedCalls();
    expect(calls.length).toBe(2);
    const feedbackMsg = calls[1].messages[calls[1].messages.length - 1];
    expect(feedbackMsg.role).toBe("user");
    expect(feedbackMsg.content).toContain("<harness:repl_output>");
    expect(feedbackMsg.content).toContain("<stdout>");
    expect(feedbackMsg.content).toContain("</stdout>");
    expect(feedbackMsg.content).toContain("</harness:repl_output>");
  });

  test("extraction errors are wrapped in harness:error XML tags", async () => {
    const rootHarness = createDeterministicHarness({
      model: "deterministic",
      responses: [
        { events: [{ type: "text", content: "no code block here" }] },
        { events: [{ type: "text", content: fence('FINAL("ok")') }] },
      ],
    });

    const rlm = createRlmHarness({
      rootHarness,
      config: defaultConfig(),
    });

    const events = await collectEvents(
      rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
    );

    const calls = rootHarness.recordedCalls();
    expect(calls.length).toBe(2);
    const errorMsg = calls[1].messages[calls[1].messages.length - 1];
    expect(errorMsg.role).toBe("user");
    expect(errorMsg.content).toContain("<harness:error>");
    expect(errorMsg.content).toContain("</harness:error>");
    expect(errorMsg.content).not.toMatch(/^error:/);
  });

  test("REPL error output uses error XML tag inside repl_output", async () => {
    const rootHarness = createDeterministicHarness({
      model: "deterministic",
      responses: [
        { events: [{ type: "text", content: fence("undefinedVar.boom") }] },
        { events: [{ type: "text", content: fence('FINAL("ok")') }] },
      ],
    });

    const rlm = createRlmHarness({
      rootHarness,
      config: defaultConfig(),
    });

    const events = await collectEvents(
      rlm.invoke({ messages: [{ role: "user", content: "test" }] }),
    );

    const calls = rootHarness.recordedCalls();
    expect(calls.length).toBe(2);
    const feedbackMsg = calls[1].messages[calls[1].messages.length - 1];
    expect(feedbackMsg.content).toContain("<harness:repl_output>");
    expect(feedbackMsg.content).toContain("<error>");
    expect(feedbackMsg.content).toContain("</error>");
  });
});
```

NOTE: This requires the deterministic harness to expose a `recordedCalls()` method. Check if it exists; if not, add it (it should record the messages array passed to each `invoke` call).

**Step 2: Verify deterministic harness has recordedCalls**

Check `packages/ai/harness/providers/deterministic.ts` for a `recordedCalls` method. If missing, add:

```ts
// Add to the harness object
const calls: { messages: Message[] }[] = [];

// In invoke(), before yielding:
calls.push({ messages: [...params.messages] });

// Expose:
recordedCalls: () => calls,
```

**Step 3: Run tests to verify they fail**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All three new tests FAIL (feedback not wrapped in XML yet)

**Step 4: Implement XML-wrapped feedback**

In `packages/ai/rlm/harness.ts`, replace the feedback assembly (~line 512-516):

```ts
const feedbackParts: string[] = [];
if (result.stdout) feedbackParts.push(`<stdout>\n${result.stdout}\n</stdout>`);
if (result.error) feedbackParts.push(`<error>${result.error}</error>`);
if (feedbackParts.length === 0) feedbackParts.push("(no output)");
const feedback = `<harness:repl_output>\n${feedbackParts.join("\n")}\n</harness:repl_output>`;
messages.push({ role: "user", content: feedback });
```

Replace the extraction error feedback (~line 457-458):

```ts
messages.push({ role: "assistant", content: responseText });
messages.push({ role: "user", content: `<harness:error>${error.message}</harness:error>` });
```

**Step 5: Run tests to verify they pass**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/ai/rlm/harness.ts packages/ai/rlm/__tests__/harness.test.ts packages/ai/harness/providers/deterministic.ts
git commit -m "feat(rlm): wrap REPL output and errors in XML tags"
```

---

### Task 3: Update system prompt

**Files:**
- Modify: `packages/ai/rlm/system-prompt.ts:102-107`
- Test: `packages/ai/rlm/__tests__/harness.test.ts` (or a new `system-prompt.test.ts`)

**Step 1: Write failing test**

```ts
import { buildRlmSystemPrompt } from "../system-prompt";

describe("system prompt", () => {
  const prompt = buildRlmSystemPrompt({
    contextLength: 100,
    contextPrefix: "hello",
  });

  test("explains harness:repl_output XML tags", () => {
    expect(prompt).toContain("<harness:repl_output>");
    expect(prompt).toContain("NOT the user speaking");
  });

  test("explains harness:error XML tags", () => {
    expect(prompt).toContain("<harness:error>");
  });

  test("forbids text after closing fence", () => {
    expect(prompt).toContain("NEVER write anything after the closing");
  });

  test("includes feedback examples", () => {
    expect(prompt).toContain("<stdout>");
    expect(prompt).toContain("</stdout>");
    expect(prompt).toContain("<error>");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All four new tests FAIL

**Step 3: Update system prompt**

In `packages/ai/rlm/system-prompt.ts`, replace the Response Format section (lines 102-106) and add Execution Feedback section:

```ts
## Response Format

Each response must contain exactly ONE \`\`\`js fenced code block. You may reason before the code block, but NEVER write anything after the closing \`\`\`. Only the code inside the fenced block is executed — any text after the closing fence is dead and will cause an error.

Do not include multiple code blocks. Do not narrate, explain, or emit code outside the fence.

## Execution Feedback

After each turn, you receive the output of your code in a user message wrapped in <harness:repl_output> tags. This is NOT the user speaking — it is automated output from the execution environment. stdout appears in <stdout> tags, errors in <error> tags.

Example — successful execution:
<harness:repl_output>
<stdout>
Total lines: 42
</stdout>
</harness:repl_output>

Example — execution error:
<harness:repl_output>
<error>ReferenceError: foo is not defined</error>
</harness:repl_output>

Example — output with error:
<harness:repl_output>
<stdout>
Processing chunk 1...
</stdout>
<error>TypeError: Cannot read property 'length' of undefined</error>
</harness:repl_output>

Example — no output:
<harness:repl_output>
(no output)
</harness:repl_output>

If your response itself is malformed (e.g. missing code block, multiple blocks, text after the closing fence), you receive a <harness:error> message instead. This is also automated feedback, not the user. Fix the issue and try again.

Example — malformed response:
<harness:error>No code block found. Respond with exactly one \`\`\`js block.</harness:error>

Write your first code block now.
```

**Step 4: Run tests to verify they pass**

Run: `bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add packages/ai/rlm/system-prompt.ts packages/ai/rlm/__tests__/harness.test.ts
git commit -m "feat(rlm): update system prompt with XML feedback docs and post-fence restriction"
```

---

### Task 4: Run full test suite and format

**Step 1: Run all RLM tests**

Run: `bun test packages/ai/rlm/`
Expected: All tests PASS

**Step 2: Format**

Run: `bun run format`

**Step 3: Run tests again after formatting**

Run: `bun test packages/ai/rlm/`
Expected: All tests PASS

**Step 4: Commit if formatting changed anything**

```bash
git add -A
git commit -m "chore: format"
```
