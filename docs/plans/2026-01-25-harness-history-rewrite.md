# Harness History Rewrite Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite git history so that at commit ad228bc: (1) openrouter-generator.ts is named openrouter.ts, and (2) anthropic.ts and openai.ts harness files exist with current implementations.

**Architecture:** Use git filter-branch or manual cherry-pick approach to rewrite history from ad228bc onward. Create a new branch at ad228bc^, apply the modified commit, then replay all subsequent commits resolving conflicts.

**Tech Stack:** Git

---

### Task 1: Capture Current Harness File Contents

**Files:**
- Read: `packages/ai/harness/openrouter-generator.ts`
- Read: `packages/ai/harness/openrouter-generator.test.ts`
- Read: `packages/ai/harness/anthropic.ts`
- Read: `packages/ai/harness/openai.ts`

**Step 1: Save current file contents to temp files**

```bash
# Save current harness implementations to /tmp for later use
cp packages/ai/harness/openrouter-generator.ts /tmp/openrouter.ts
cp packages/ai/harness/openrouter-generator.test.ts /tmp/openrouter.test.ts
cp packages/ai/harness/anthropic.ts /tmp/anthropic.ts
cp packages/ai/harness/openai.ts /tmp/openai.ts
```

**Step 2: Update the temp openrouter files to use correct names**

In `/tmp/openrouter.ts`, change the export from:
```typescript
export const openRouterGeneratorHarness = createGeneratorHarness();
```
to:
```typescript
export const openRouterHarness = createGeneratorHarness();
```

In `/tmp/openrouter.test.ts`, update imports from:
```typescript
import { createGeneratorHarness, openRouterGeneratorHarness } from "./openrouter-generator";
```
to:
```typescript
import { createGeneratorHarness, openRouterHarness } from "./openrouter";
```

And update all references from `openRouterGeneratorHarness` to `openRouterHarness`.

---

### Task 2: Create Rewrite Branch

**Step 1: Create branch at parent of ad228bc**

```bash
git checkout -b rewrite-harness ad228bc^
```

Expected: Switched to new branch 'rewrite-harness'

---

### Task 3: Add Harness Files with Correct Names

**Files:**
- Create: `packages/ai/harness/openrouter.ts`
- Create: `packages/ai/harness/openrouter.test.ts`
- Create: `packages/ai/harness/anthropic.ts`
- Create: `packages/ai/harness/openai.ts`

**Step 1: Copy prepared files into place**

```bash
cp /tmp/openrouter.ts packages/ai/harness/openrouter.ts
cp /tmp/openrouter.test.ts packages/ai/harness/openrouter.test.ts
cp /tmp/anthropic.ts packages/ai/harness/anthropic.ts
cp /tmp/openai.ts packages/ai/harness/openai.ts
```

**Step 2: Stage all files**

```bash
git add packages/ai/harness/openrouter.ts packages/ai/harness/openrouter.test.ts packages/ai/harness/anthropic.ts packages/ai/harness/openai.ts
```

**Step 3: Commit with original ad228bc metadata**

```bash
git commit --author="Henry Ventura <hvent90@gmail.com>" --date="Sun Jan 25 10:34:57 2026 -0800" -m "$(cat <<'EOF'
feat(harness): add generator-based OpenRouter harness

Port OpenRouter harness to AsyncGenerator pattern:
- async *invoke() yields events instead of using emit callback
- Permission blocking via deferred promise (generator pauses until respond() called)
- Integrated agent loop that continues with tool results
- Implements GeneratorHarnessModule interface from types.ts

The generator pattern enables cleaner control flow and makes it easy
for consumers to pause/resume execution when handling permissions.

Also adds Anthropic and OpenAI harness implementations.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Replay Subsequent Commits

**Step 1: Cherry-pick 270b966 (first "updates" commit)**

This commit modified openrouter-generator.ts, so it will conflict. We need to skip changes to that file since our version already has them.

```bash
git cherry-pick 270b966 --no-commit
# If conflict on openrouter-generator.ts, remove it and keep our openrouter.ts
git rm packages/ai/harness/openrouter-generator.ts 2>/dev/null || true
git rm packages/ai/harness/openrouter-generator.test.ts 2>/dev/null || true
git checkout HEAD -- packages/ai/harness/openrouter.ts packages/ai/harness/openrouter.test.ts
git add -A
git commit -C 270b966
```

**Step 2: Cherry-pick remaining commits**

```bash
git cherry-pick cd07839 341706e 8f9c28a 411606b cd5d927
```

Expected: All commits applied cleanly (they don't touch harness files)

---

### Task 5: Update Main Branch

**Step 1: Move main to rewritten history**

```bash
git checkout main
git reset --hard rewrite-harness
git branch -d rewrite-harness
```

**Step 2: Verify files exist at the original commit location**

```bash
git log --oneline | head -10
git show <new-ad228bc-equivalent-hash> --name-only
```

Expected: Should show openrouter.ts, openrouter.test.ts, anthropic.ts, openai.ts

---

### Task 6: Update Any Import References

**Step 1: Search for references to old filename**

```bash
grep -r "openrouter-generator" --include="*.ts" --include="*.tsx" .
```

**Step 2: Update any found references**

Change imports from:
```typescript
import { ... } from "./openrouter-generator";
```
to:
```typescript
import { ... } from "./openrouter";
```

**Step 3: Commit if changes were needed**

```bash
git add -A
git commit -m "refactor: update imports after harness file rename"
```

---

### Task 7: Verify and Clean Up

**Step 1: Run tests to verify nothing is broken**

```bash
bun test
```

**Step 2: Verify git history**

```bash
git log --oneline --all | head -15
git log --follow -- packages/ai/harness/openrouter.ts
```

Expected: History shows openrouter.ts was created at the beginning, not renamed.
