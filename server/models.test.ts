import { describe, it, expect } from "bun:test";
import { createApp } from "./index";
import { createDeterministicHarness } from "../packages/ai/harness/providers/deterministic";
import { createAgentHarness } from "../packages/ai/harness/agent";

describe("GET /models", () => {
  it("returns the models supported by the configured harness", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({
        responses: [],
        models: ["model-a", "model-b"],
      }),
    });
    const app = createApp({ harness });

    const response = await app.request("/models", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: string[] };
    expect(body.models).toEqual(["model-a", "model-b"]);
  });

  it("returns default harness models when no harness is configured", async () => {
    const app = createApp();

    const response = await app.request("/models", { method: "GET" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: string[] };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

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
});

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
