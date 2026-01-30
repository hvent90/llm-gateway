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
});
