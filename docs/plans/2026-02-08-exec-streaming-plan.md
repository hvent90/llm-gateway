# Exec Streaming & Process Monitoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream stdout/stderr and process metrics from `exec()` calls in real-time to the consumer via a new `tool_progress` event.

**Architecture:** Extend the existing `AsyncQueue` drain loop pattern (used for HITL relay) to also push `tool_progress` events during exec(). Replace the `execShell()` call in the RLM harness with inline `Bun.spawn` to get access to live streams and PID. Poll process metrics every 1s via `ps`.

**Tech Stack:** Bun (spawn, ReadableStream), existing AsyncQueue primitive

**Design doc:** `docs/plans/2026-02-08-exec-streaming-design.md`

---

### Task 1: Add `tool_progress` to HarnessEvent union

**Files:**
- Modify: `packages/ai/types.ts:77-100`

**Step 1: Add the new event type to the union**

In `packages/ai/types.ts`, add this variant to the `HarnessEvent` union (after the `tool_result` variant, before `usage`):

```ts
  | {
      type: "tool_progress";
      runId: string;
      id: string;
      parentId?: string;
      toolCallId: string;
      name: string;
      content: unknown;
    }
```

**Step 2: Verify types compile**

Run: `cd /Users/hv/repos/llm-gateway && bun build packages/ai/types.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

**Step 3: Commit**

```bash
git add packages/ai/types.ts
git commit -m "feat(types): add tool_progress event to HarnessEvent union"
```

---

### Task 2: Expand ExecQueueItem in harness

**Files:**
- Modify: `packages/ai/rlm/harness.ts:86-88`

**Step 1: Add `progress` variant to ExecQueueItem**

In `packages/ai/rlm/harness.ts`, expand the `ExecQueueItem` type (line 86-88) from:

```ts
      type ExecQueueItem =
        | { type: "relay"; event: RelayEvent }
        | { type: "repl_done"; result: ReplExecutionResult };
```

to:

```ts
      type ExecQueueItem =
        | { type: "relay"; event: RelayEvent }
        | { type: "progress"; event: HarnessEvent }
        | { type: "repl_done"; result: ReplExecutionResult };
```

**Step 2: Verify the drain loop handles it**

The existing drain loop at lines 181-188 already works:

```ts
        while (true) {
          const item = await currentQueue.pop();
          if (item.type === "repl_done") {
            result = item.result;
            break;
          }
          yield item.event; // works for both "relay" and "progress"
        }
```

No drain loop changes needed — both `relay` and `progress` have an `event` field that gets yielded.

**Step 3: Verify types compile**

Run: `cd /Users/hv/repos/llm-gateway && bun build packages/ai/rlm/harness.ts --no-bundle 2>&1 | head -20`
Expected: No type errors

**Step 4: Run existing tests to confirm no regressions**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add packages/ai/rlm/harness.ts
git commit -m "feat(rlm): add progress variant to ExecQueueItem"
```

---

### Task 3: Implement monitored exec with streaming

**Files:**
- Modify: `packages/ai/rlm/harness.ts:92-123` (the `exec` callback)

This is the core task. Replace the `execShell()` call with inline `Bun.spawn` that:
1. Drains stdout/stderr as chunks arrive, pushing `tool_progress` events
2. Polls process metrics every 1s, pushing `tool_progress` events
3. Still returns `ShellResult` (same shape as before)
4. Preserves timeout/kill behavior from `execShell`

**Step 1: Write failing test — exec produces tool_progress events with stdout**

Add to `packages/ai/rlm/__tests__/harness.test.ts`, inside a new `describe("exec streaming")` block:

```ts
  describe("exec streaming", () => {
    test("exec produces tool_progress events with stdout chunks", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content:
                  'const r = await exec("echo hello && sleep 0.1 && echo world");\nFINAL(r.stdout.trim());',
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
        rlm.invoke({
          messages: [{ role: "user", content: "test streaming" }],
        }),
      );

      // Should have tool_progress events between tool_call and tool_result
      const progressEvents = events.filter((e) => e.type === "tool_progress");
      expect(progressEvents.length).toBeGreaterThan(0);

      // Progress events should have stdout content
      const stdoutProgress = progressEvents.filter(
        (e) =>
          e.type === "tool_progress" &&
          (e.content as { channel?: string }).channel === "stdout",
      );
      expect(stdoutProgress.length).toBeGreaterThan(0);

      // Final result should still work
      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toContain("hello");
        expect(textEvent.content).toContain("world");
      }
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts --test-name-pattern "exec produces tool_progress"`
Expected: FAIL — no `tool_progress` events exist yet

**Step 3: Implement monitored exec**

Replace the exec callback body in `packages/ai/rlm/harness.ts` (lines 92-123). Remove the `execShell` import (line 13) and add `spawn` from `bun`. The new exec callback:

```ts
      const exec = async (command: string, timeout?: number) => {
        // Permission check (unchanged)
        if (params.permissions) {
          const isAllowed = matchesPermissions(
            { name: "exec", arguments: { command } },
            params.permissions,
          );

          if (!isAllowed) {
            const d = deferred<PermissionResponse>();
            const relayEvent: RelayEvent = tag({
              type: "relay" as const,
              kind: "permission" as const,
              runId,
              id: uuidv7(),
              toolCallId: uuidv7(),
              tool: "exec",
              params: { command },
              respond: (response: PermissionResponse) => d.resolve(response),
            });

            execEvents?.push({ type: "relay", event: relayEvent });

            const decision = await d.promise;
            if (!decision.approved) {
              throw new Error(`exec denied: ${decision.reason ?? "permission denied"}`);
            }
          }
        }

        // Spawn process with access to live streams
        const effectiveTimeout = timeout ?? config.execTimeout ?? 10;
        const proc = spawn({
          cmd: ["sh", "-c", command],
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });

        const startTime = Date.now();
        let stdoutBuf = "";
        let stderrBuf = "";

        const toolCallId = uuidv7();

        // Helper to push a tool_progress event onto the queue
        const pushProgress = (content: unknown) => {
          execEvents?.push({
            type: "progress",
            event: tag({
              type: "tool_progress" as const,
              runId,
              id: uuidv7(),
              toolCallId,
              name: "exec",
              content,
            }),
          });
        };

        // Drain a readable stream, collecting into buffer and pushing progress events
        const drainStream = async (
          stream: ReadableStream<Uint8Array>,
          channel: "stdout" | "stderr",
        ): Promise<string> => {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          const chunks: string[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              chunks.push(text);
              pushProgress({ channel, data: text });
            }
          } catch {
            // Stream cancelled — return what we have
          }
          return chunks.join("");
        };

        // Poll process metrics every 1s
        let metricsRunning = true;
        const pollMetrics = async () => {
          while (metricsRunning) {
            await Bun.sleep(1000);
            if (!metricsRunning) break;
            try {
              const ps = spawn({
                cmd: ["ps", "-p", String(proc.pid), "-o", "%cpu,rss"],
                stdout: "pipe",
                stderr: "pipe",
              });
              const output = await new Response(ps.stdout).text();
              await ps.exited;
              const lines = output.trim().split("\n");
              if (lines.length >= 2) {
                const [cpu, rss] = lines[1].trim().split(/\s+/);
                pushProgress({
                  pid: proc.pid,
                  cpuPercent: parseFloat(cpu),
                  rssKb: parseInt(rss, 10),
                  wallMs: Date.now() - startTime,
                });
              }
            } catch {
              // Process may have exited — stop polling
              break;
            }
          }
        };

        const stdoutReader = proc.stdout.getReader();
        const stderrReader = proc.stderr.getReader();

        const kill = () => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {}
          try {
            proc.kill(9);
          } catch {}
          stdoutReader.cancel().catch(() => {});
          stderrReader.cancel().catch(() => {});
        };

        // Release readers — drainStream will get its own
        stdoutReader.releaseLock();
        stderrReader.releaseLock();

        const metricsPromise = pollMetrics();

        const completionPromise = (async () => {
          const [stdout, stderr] = await Promise.all([
            drainStream(proc.stdout, "stdout"),
            drainStream(proc.stderr, "stderr"),
          ]);
          const exitCode = await proc.exited;
          return { stdout, stderr, exitCode, timedOut: false as const };
        })();

        completionPromise.catch(() => {});

        let timer: Timer;
        const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => {
            kill();
            resolve({ timedOut: true });
          }, effectiveTimeout * 1000);
        });

        const raceResult = await Promise.race([completionPromise, timeoutPromise]);
        clearTimeout(timer!);
        metricsRunning = false;
        await metricsPromise.catch(() => {});

        if (raceResult.timedOut) {
          return { exitCode: -1, stdout: "", stderr: "" };
        }

        return {
          stdout: raceResult.stdout,
          stderr: raceResult.stderr,
          exitCode: raceResult.exitCode,
        };
      };
```

Also update the import at the top of the file — remove `execShell` import (line 13), add `spawn` from `bun`:

```ts
import { spawn } from "bun";
```

Remove:
```ts
import { execShell } from "../tools/lib/shell";
```

**Step 4: Run the failing test to verify it passes**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts --test-name-pattern "exec produces tool_progress"`
Expected: PASS

**Step 5: Run all harness tests to confirm no regressions**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All tests pass

**Step 6: Commit**

```bash
git add packages/ai/rlm/harness.ts packages/ai/rlm/__tests__/harness.test.ts
git commit -m "feat(rlm): stream exec stdout/stderr and process metrics via tool_progress"
```

---

### Task 4: Add test for exec metrics polling

**Files:**
- Modify: `packages/ai/rlm/__tests__/harness.test.ts`

**Step 1: Write test — exec produces metrics for long-running commands**

Add inside the `describe("exec streaming")` block:

```ts
    test("exec produces metrics events for long-running commands", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content:
                  'const r = await exec("sleep 2 && echo done");\nFINAL(r.stdout.trim());',
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig({ execTimeout: 5 }),
      });

      const events = await collectEvents(
        rlm.invoke({
          messages: [{ role: "user", content: "test metrics" }],
        }),
      );

      // Should have at least 1 metrics event (1s poll, command takes ~2s)
      const metricsEvents = events.filter(
        (e) =>
          e.type === "tool_progress" &&
          typeof (e.content as { pid?: number }).pid === "number",
      );
      expect(metricsEvents.length).toBeGreaterThanOrEqual(1);

      // Metrics should have expected shape
      const m = metricsEvents[0] as { type: "tool_progress"; content: unknown };
      const content = m.content as {
        pid: number;
        cpuPercent: number;
        rssKb: number;
        wallMs: number;
      };
      expect(content.pid).toBeGreaterThan(0);
      expect(typeof content.cpuPercent).toBe("number");
      expect(typeof content.rssKb).toBe("number");
      expect(content.wallMs).toBeGreaterThanOrEqual(1000);

      // Final result should still work
      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("done");
      }
    });
```

**Step 2: Run test**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts --test-name-pattern "exec produces metrics"`
Expected: PASS (implementation already done in Task 3)

**Step 3: Commit**

```bash
git add packages/ai/rlm/__tests__/harness.test.ts
git commit -m "test(rlm): add test for exec metrics polling"
```

---

### Task 5: Add test for stderr streaming

**Files:**
- Modify: `packages/ai/rlm/__tests__/harness.test.ts`

**Step 1: Write test — exec streams stderr via tool_progress**

Add inside the `describe("exec streaming")` block:

```ts
    test("exec streams stderr via tool_progress", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content:
                  'const r = await exec("echo err >&2 && echo out");\nFINAL(r.stdout.trim());',
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
        rlm.invoke({
          messages: [{ role: "user", content: "test stderr" }],
        }),
      );

      const progressEvents = events.filter((e) => e.type === "tool_progress");

      const stderrProgress = progressEvents.filter(
        (e) =>
          e.type === "tool_progress" &&
          (e.content as { channel?: string }).channel === "stderr",
      );
      expect(stderrProgress.length).toBeGreaterThan(0);

      const stderrContent = stderrProgress
        .map((e) => (e as { content: { data: string } }).content.data)
        .join("");
      expect(stderrContent).toContain("err");
    });
```

**Step 2: Run test**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts --test-name-pattern "exec streams stderr"`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/ai/rlm/__tests__/harness.test.ts
git commit -m "test(rlm): add test for stderr streaming via tool_progress"
```

---

### Task 6: Add test for tool_progress event ordering

**Files:**
- Modify: `packages/ai/rlm/__tests__/harness.test.ts`

**Step 1: Write test — tool_progress events appear between tool_call and tool_result**

Add inside the `describe("exec streaming")` block:

```ts
    test("tool_progress events appear between tool_call and tool_result", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content:
                  'const r = await exec("echo ordering");\nFINAL(r.stdout.trim());',
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
        rlm.invoke({
          messages: [{ role: "user", content: "test ordering" }],
        }),
      );

      const types = events.map((e) => e.type);
      const toolCallIdx = types.indexOf("tool_call");
      const toolResultIdx = types.indexOf("tool_result");
      const progressIdx = types.indexOf("tool_progress");

      expect(progressIdx).toBeGreaterThan(toolCallIdx);
      expect(progressIdx).toBeLessThan(toolResultIdx);
    });
```

**Step 2: Run test**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts --test-name-pattern "tool_progress events appear between"`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/ai/rlm/__tests__/harness.test.ts
git commit -m "test(rlm): verify tool_progress ordering between tool_call and tool_result"
```

---

### Task 7: Add test for exec streaming with HITL relay

**Files:**
- Modify: `packages/ai/rlm/__tests__/harness.test.ts`

**Step 1: Write test — streaming works alongside HITL relay**

Add inside the `describe("exec streaming")` block:

```ts
    test("exec streaming works alongside HITL relay", async () => {
      const rootHarness = createDeterministicHarness({
        model: "deterministic",
        responses: [
          {
            events: [
              {
                type: "text",
                content:
                  'const r = await exec("echo relayed");\nFINAL(r.stdout.trim());',
              },
            ],
          },
        ],
      });

      const rlm = createRlmHarness({
        rootHarness,
        config: defaultConfig(),
      });

      const relays: RelayEvent[] = [];
      const events = await collectEventsWithRelays(
        rlm.invoke({
          messages: [{ role: "user", content: "test streaming with relay" }],
          permissions: { allowlist: [] },
        }),
        (relay) => {
          relays.push(relay);
          relay.respond({ approved: true });
        },
      );

      // Should have relay event
      expect(relays.length).toBe(1);

      // Should also have tool_progress events
      const progressEvents = events.filter((e) => e.type === "tool_progress");
      expect(progressEvents.length).toBeGreaterThan(0);

      // Final result should work
      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.content).toBe("relayed");
      }
    });
```

Note: `collectEventsWithRelays` is already defined in the test file (line 377-387).

**Step 2: Run test**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts --test-name-pattern "exec streaming works alongside"`
Expected: PASS

**Step 3: Run full test suite**

Run: `cd /Users/hv/repos/llm-gateway && bun test packages/ai/rlm/__tests__/harness.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/ai/rlm/__tests__/harness.test.ts
git commit -m "test(rlm): verify exec streaming works alongside HITL relay"
```

---

### Task 8: Format and final verification

**Step 1: Format**

Run: `cd /Users/hv/repos/llm-gateway && bun run format`

**Step 2: Run full test suite**

Run: `cd /Users/hv/repos/llm-gateway && bun test`
Expected: All tests pass

**Step 3: Commit formatting if needed**

```bash
git add -A
git commit -m "style: format"
```
