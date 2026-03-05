# Design: RLM Harness Feedback Clarity

## Problem

RCA analysis of a minimax-m2.5 trajectory identified three system-design root causes where the harness confuses models about execution feedback:

- **RC1**: Post-fence text persists in message history, model mistakes its own narration for real content
- **RC5**: Error messages arrive as plain `{ role: "user" }` messages, indistinguishable from human input
- **Adjacent**: Multiple code blocks silently concatenated instead of rejected

## Fixes

### Fix 1: XML-wrapped REPL output

Wrap execution feedback in `<harness:repl_output>` XML tags with `<stdout>` and `<error>` sub-tags. Update system prompt to explain this convention and clarify that these messages are automated output, not the user speaking.

**harness.ts** (feedback assembly, ~line 512):

```ts
// Before
const feedbackParts: string[] = [];
if (result.stdout) feedbackParts.push(`stdout:\n${result.stdout}`);
if (result.error) feedbackParts.push(`error: ${result.error}`);
if (feedbackParts.length === 0) feedbackParts.push("(no output)");
messages.push({ role: "user", content: feedbackParts.join("\n") });

// After
const feedbackParts: string[] = [];
if (result.stdout) feedbackParts.push(`<stdout>\n${result.stdout}\n</stdout>`);
if (result.error) feedbackParts.push(`<error>${result.error}</error>`);
if (feedbackParts.length === 0) feedbackParts.push("(no output)");
const feedback = `<harness:repl_output>\n${feedbackParts.join("\n")}\n</harness:repl_output>`;
messages.push({ role: "user", content: feedback });
```

### Fix 2: Strict extractCode validation

Replace silent multi-block concatenation with explicit errors. Add post-fence text detection.

**harness.ts** (`extractCode`, ~line 30):

```ts
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

### Fix 3: Updated system prompt — Response Format

```
## Response Format

Each response must contain exactly ONE ```js fenced code block. You may reason before
the code block, but NEVER write anything after the closing ```. Only the code inside
the fenced block is executed — any text after the closing fence is dead and will cause
an error.

Do not include multiple code blocks. Do not narrate, explain, or emit code outside the fence.

Write your first code block now.
```

### Fix 4: XML-wrapped extraction errors + system prompt documentation

**harness.ts** (extraction error feedback, ~line 457):

```ts
// Before
messages.push({ role: "assistant", content: responseText });
messages.push({ role: "user", content: `error: ${error.message}` });

// After
messages.push({ role: "assistant", content: responseText });
messages.push({ role: "user", content: `<harness:error>${error.message}</harness:error>` });
```

**system-prompt.ts** — new Execution Feedback section:

```
## Execution Feedback

After each turn, you receive the output of your code in a user message wrapped in
<harness:repl_output> tags. This is NOT the user speaking — it is automated output
from the execution environment. stdout appears in <stdout> tags, errors in <error> tags.

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

If your response itself is malformed (e.g. missing code block, multiple blocks, text after
the closing fence), you receive a <harness:error> message instead. This is also automated
feedback, not the user. Fix the issue and try again.

Example — malformed response:
<harness:error>No code block found. Respond with exactly one ```js block.</harness:error>
```

## Files Changed

| File | Change |
|------|--------|
| `packages/ai/rlm/harness.ts` | XML-wrapped feedback, strict extractCode, XML-wrapped errors |
| `packages/ai/rlm/system-prompt.ts` | Response Format update, Execution Feedback section |

## Testing

- Existing `extractCode` tests updated for new error cases (multi-block, post-fence text)
- New test: REPL output feedback format contains XML tags
- New test: extraction error feedback contains `<harness:error>` tags
- Existing harness integration tests updated to expect XML-wrapped feedback in message history
