import { describe, it, expect } from "bun:test";

const BASE_URL = "http://localhost:4000";

/**
 * Parse SSE events from a ReadableStream.
 * Returns array of parsed { event, data } objects.
 */
async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ event: string; data: unknown }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent = "";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
        } else if (line === "" && currentEvent && currentData) {
          yield { event: currentEvent, data: JSON.parse(currentData) };
          currentEvent = "";
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("Server /chat endpoint", () => {
  it("should return 400 for invalid JSON body", async () => {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  it("should return 400 when model is missing", async () => {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("model and messages are required");
  });

  it("should return 400 when messages is missing", async () => {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o-mini" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("model and messages are required");
  });

  it("should stream SSE events with sessionId in connected event", async () => {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say just 'hi' with no other text" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events: Array<{ event: string; data: unknown }> = [];
    for await (const e of parseSSE(response.body!)) {
      events.push(e);
    }

    // Should have a connected event with sessionId
    const connectedEvent = events.find((e) => e.event === "connected");
    expect(connectedEvent).toBeDefined();
    expect((connectedEvent!.data as { sessionId: string }).sessionId).toBeDefined();
  });

  it("should include agentId in all events after connected", async () => {
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say just 'ok' with no other text" }],
      }),
    });
    expect(response.status).toBe(200);

    const events: Array<{ event: string; data: unknown }> = [];
    for await (const e of parseSSE(response.body!)) {
      events.push(e);
    }

    // All events after connected should have agentId
    const nonConnectedEvents = events.filter((e) => e.event !== "connected");
    for (const e of nonConnectedEvents) {
      expect((e.data as { agentId?: string }).agentId).toBeDefined();
    }
  });
});

describe("Server /chat/permission/:toolCallId endpoint", () => {
  it("should return 400 when sessionId is missing", async () => {
    const response = await fetch(`${BASE_URL}/chat/permission/test-tool-call-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("sessionId and approved are required");
  });

  it("should return 400 when approved is missing", async () => {
    const response = await fetch(`${BASE_URL}/chat/permission/test-tool-call-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "test-session" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("sessionId and approved are required");
  });

  it("should return 404 when sessionId does not exist", async () => {
    const response = await fetch(`${BASE_URL}/chat/permission/test-tool-call-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "nonexistent", approved: true }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Session not found or permission request not found");
  });

  it("should complete permission round-trip: permission_required -> approve -> tool executes", async () => {
    // Start a chat with empty allowlist so all tools require permission
    const response = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "user",
            content:
              "Use the bash tool to run 'echo hello'. Do not say anything else, just call the tool immediately.",
          },
        ],
        permissions: { allowlist: [] }, // Empty allowlist means all tools require permission
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events: Array<{ event: string; data: unknown }> = [];
    let sessionId: string | undefined;
    let toolCallId: string | undefined;
    let permissionApproved = false;

    // Create a reader to manually control reading
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readNextEvents = async (): Promise<Array<{ event: string; data: unknown }>> => {
      const newEvents: Array<{ event: string; data: unknown }> = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData = line.slice(5).trim();
          } else if (line === "" && currentEvent && currentData) {
            newEvents.push({ event: currentEvent, data: JSON.parse(currentData) });
            currentEvent = "";
            currentData = "";
          }
        }

        // If we got events, return them
        if (newEvents.length > 0) {
          return newEvents;
        }
      }

      return newEvents;
    };

    // Read events until we get permission_required or the stream ends
    let maxIterations = 50; // Safety limit
    while (maxIterations-- > 0) {
      const newEvents = await readNextEvents();
      if (newEvents.length === 0) break;

      for (const e of newEvents) {
        events.push(e);

        // Extract sessionId from connected event
        if (e.event === "connected") {
          sessionId = (e.data as { sessionId: string }).sessionId;
        }

        // When we get permission_required, approve it
        if (e.event === "permission_required" && !permissionApproved) {
          const data = e.data as { toolCallId: string; tool: string };
          toolCallId = data.toolCallId;

          // POST approval
          const approvalResponse = await fetch(`${BASE_URL}/chat/permission/${toolCallId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, approved: true }),
          });

          expect(approvalResponse.status).toBe(200);
          const approvalBody = (await approvalResponse.json()) as { success: boolean };
          expect(approvalBody.success).toBe(true);
          permissionApproved = true;
        }
      }
    }

    reader.releaseLock();

    // Verify we got the expected events
    expect(sessionId).toBeDefined();
    expect(toolCallId).toBeDefined();
    expect(permissionApproved).toBe(true);

    // Should have connected event
    const connectedEvent = events.find((e) => e.event === "connected");
    expect(connectedEvent).toBeDefined();

    // Should have permission_required event for bash tool
    const permissionEvent = events.find((e) => e.event === "permission_required");
    expect(permissionEvent).toBeDefined();
    expect((permissionEvent!.data as { tool: string }).tool).toBe("bash");

    // After approval, should have tool_call event
    const toolCallEvent = events.find((e) => e.event === "tool_call");
    expect(toolCallEvent).toBeDefined();
    expect((toolCallEvent!.data as { name: string }).name).toBe("bash");

    // Should have tool_result event with the output
    const toolResultEvent = events.find((e) => e.event === "tool_result");
    expect(toolResultEvent).toBeDefined();
    expect((toolResultEvent!.data as { name: string }).name).toBe("bash");
  }, 60000); // 60 second timeout for LLM call
});
