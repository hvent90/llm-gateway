import { describe, it, expect } from "bun:test";
import { createApp } from "./index";
import { createDeterministicHarness } from "../packages/ai/harness/providers/deterministic";
import { createAgentHarness } from "../packages/ai/harness/agent";

function parseSSEEvents(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split("\n\n").filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        events.push({ event, data });
      }
    }
  }
  return events;
}

describe("POST /summarize", () => {
  it("returns 400 for invalid JSON", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({ responses: [], models: ["model-a"] }),
    });
    const app = await createApp({ harness });

    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  it("returns 400 when model or messages missing", async () => {
    const harness = createAgentHarness({
      harness: createDeterministicHarness({ responses: [], models: ["model-a"] }),
    });
    const app = await createApp({ harness });

    // Missing both model and messages
    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceIds: ["abc"] }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("model and messages are required");
  });

  it("streams summary text events and includes sourceIds in connected event", async () => {
    // The main harness (for /chat) — agent harness wrapping a deterministic provider
    const harness = createAgentHarness({
      harness: createDeterministicHarness({ responses: [], models: ["model-a"] }),
    });

    // The provider harness for /summarize — raw deterministic provider, no agent loop
    const providerHarness = createDeterministicHarness({
      responses: [{ events: [{ type: "text", content: "This is the summary." }] }],
      models: ["model-a"],
    });

    const app = await createApp({ harness, providerHarness, defaultModel: "model-a" });

    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "model-a",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
        sourceIds: ["source-1", "source-2"],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    const events = parseSSEEvents(text);

    // First event should be "connected" with sessionId and sourceIds
    const connected = events.find((e) => e.event === "connected");
    expect(connected).toBeDefined();
    const connData = connected!.data as { type: string; sessionId: string; sourceIds: string[] };
    expect(connData.type).toBe("connected");
    expect(connData.sessionId).toBeDefined();
    expect(connData.sourceIds).toEqual(["source-1", "source-2"]);

    // Should have a text event with the summary content
    const textEvents = events.filter((e) => e.event === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    const textData = textEvents[0].data as { type: string; content: string };
    expect(textData.type).toBe("text");
    expect(textData.content).toBe("This is the summary.");
  });

  it("uses defaultModel when model is not provided", async () => {
    const providerHarness = createDeterministicHarness({
      responses: [{ events: [{ type: "text", content: "Summary." }] }],
      models: ["default-model"],
    });
    const agentHarness = createAgentHarness({ harness: providerHarness });
    const app = await createApp({
      harness: agentHarness,
      providerHarness,
      defaultModel: "default-model",
    });

    const response = await app.request("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        sourceIds: ["msg_1"],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });
});
