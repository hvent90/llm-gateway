# Default Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow a `DEFAULT_MODEL` env var to set the pre-selected model in the web client and serve as fallback when no model is specified in chat requests.

**Architecture:** Server-level `defaultModel` config validated against the harness's `supportedModels()`. Exposed to the frontend via `GET /models`. Used as fallback in `POST /chat`.

**Tech Stack:** Bun, Hono, deterministic harness for tests

---

### Task 1: `GET /models` returns validated `defaultModel`

**Files:**
- Modify: `server/models.test.ts`
- Modify: `server/index.ts`

**Step 1: Write failing tests**

Add two tests to `server/models.test.ts`:

```ts
it("includes defaultModel when it matches a supported model", async () => {
  const harness = createAgentHarness({
    harness: createDeterministicHarness({
      responses: [],
      models: ["model-a", "model-b"],
    }),
  });
  const app = createApp({ harness, defaultModel: "model-b" });

  const response = await app.request("/models", { method: "GET" });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { models: string[]; defaultModel?: string };
  expect(body.defaultModel).toBe("model-b");
});

it("omits defaultModel when it is not in the supported models list", async () => {
  const harness = createAgentHarness({
    harness: createDeterministicHarness({
      responses: [],
      models: ["model-a", "model-b"],
    }),
  });
  const app = createApp({ harness, defaultModel: "model-c" });

  const response = await app.request("/models", { method: "GET" });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { models: string[]; defaultModel?: string };
  expect(body.defaultModel).toBeUndefined();
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test server/models.test.ts`
Expected: FAIL — `AppConfig` doesn't accept `defaultModel` yet.

**Step 3: Implement**

In `server/index.ts`:

1. Add `defaultModel?: string` to `AppConfig`.
2. Read it in `createApp`: `const defaultModel = config?.defaultModel;`
3. Update `GET /models` handler:

```ts
app.get("/models", async (c) => {
  const models = await harness.supportedModels();
  const validDefault = defaultModel && models.includes(defaultModel) ? defaultModel : undefined;
  return c.json({ models, ...(validDefault && { defaultModel: validDefault }) });
});
```

**Step 4: Run tests to verify they pass**

Run: `bun test server/models.test.ts`
Expected: All PASS.

**Step 5: Commit**

```bash
git add server/models.test.ts server/index.ts
git commit -m "feat: GET /models returns validated defaultModel from config"
```

---

### Task 2: `POST /chat` falls back to `defaultModel`

**Files:**
- Modify: `server/models.test.ts` (add chat default model tests here since they use deterministic harness via `app.request`)
- Modify: `server/index.ts`

**Step 1: Write failing tests**

Add a new describe block in `server/models.test.ts`:

```ts
describe("POST /chat default model", () => {
  it("uses defaultModel when model is not provided in the request", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({
        responses: [{ events: [{ type: "text", content: "hello" }] }],
        models: ["model-a"],
      }),
    });
    const app = createApp({ harness, defaultModel: "model-a" });

    const response = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("returns 400 when no model provided and no default configured", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({ responses: [], models: ["model-a"] }),
    });
    const app = createApp({ harness });

    const response = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(400);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test server/models.test.ts`
Expected: FAIL — `/chat` currently requires `body.model`.

**Step 3: Implement**

In `server/index.ts`, update the `POST /chat` handler:

Change the validation from:
```ts
if (!body.model || !body.messages) {
  return c.json({ error: "model and messages are required" }, 400);
}
```

To:
```ts
const model = body.model || defaultModel;
if (!model || !body.messages) {
  return c.json({ error: "model and messages are required" }, 400);
}
```

And use `model` instead of `body.model` when spawning:
```ts
const agentId = orchestrator.spawn({
  model,
  messages: body.messages,
  tools,
  permissions: body.permissions,
});
```

**Step 4: Run tests to verify they pass**

Run: `bun test server/models.test.ts`
Expected: All PASS.

**Step 5: Commit**

```bash
git add server/models.test.ts server/index.ts
git commit -m "feat: POST /chat falls back to defaultModel when model omitted"
```

---

### Task 3: Production app reads `DEFAULT_MODEL` env var

**Files:**
- Modify: `server/index.ts`

**Step 1: Update production app creation**

At the bottom of `server/index.ts`, change:
```ts
const app = createApp();
```

To:
```ts
const app = createApp({
  defaultModel: process.env.DEFAULT_MODEL,
});
```

**Step 2: Run all server tests**

Run: `bun test server/`
Expected: All PASS (no behavior change for tests, they pass their own config).

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: production app reads DEFAULT_MODEL env var"
```

---

### Task 4: Frontend pre-selects `defaultModel`

**Files:**
- Modify: `clients/web/src/App.tsx`

**Step 1: Update the `/models` fetch handler**

In the `useEffect` that fetches `/models`, change:
```ts
.then((data: { models: string[] }) => {
  setModels(data.models);
  if (data.models.length > 0) setSelectedModel(data.models[0]);
})
```

To:
```ts
.then((data: { models: string[]; defaultModel?: string }) => {
  setModels(data.models);
  if (data.defaultModel) {
    setSelectedModel(data.defaultModel);
  } else if (data.models.length > 0) {
    setSelectedModel(data.models[0]);
  }
})
```

**Step 2: Verify manually**

Run: `DEFAULT_MODEL=some-model bun run dev`
Open web client, confirm the dropdown pre-selects the configured model.

**Step 3: Commit**

```bash
git add clients/web/src/App.tsx
git commit -m "feat: web client pre-selects defaultModel from server"
```
