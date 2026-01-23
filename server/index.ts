import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { openRouterHarness } from "../packages/ai/harness/openrouter.ts";
import { createAgentHarness } from "../packages/ai/harness/agent.ts";
import { bashTool } from "../packages/ai/tools/index.ts";
import type { Message, HarnessEvent, Permissions } from "../packages/ai/types.ts";

const agentHarness = createAgentHarness({
  harness: openRouterHarness,
  maxIterations: 10,
});

const app = new Hono();

interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
}

// Serialize a HarnessEvent to JSON-safe format
function serializeEvent(event: HarnessEvent): object {
  if (event.type === "error") {
    return {
      type: event.type,
      runId: event.runId,
      ...(event.parentId && { parentId: event.parentId }),
      message: event.error.message,
    };
  }
  return event;
}

app.post("/chat", async (c) => {
  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.model || !body.messages) {
    return c.json({ error: "model and messages are required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    // Queue to ensure events are written in order
    const writeQueue: Promise<void>[] = [];

    const emit = (event: HarnessEvent) => {
      const writePromise = stream.writeSSE({
        event: event.type,
        data: JSON.stringify(serializeEvent(event)),
      });
      writeQueue.push(writePromise);
    };

    try {
      await agentHarness.invoke({
        model: body.model,
        messages: body.messages,
        tools: [bashTool],
        emit,
        permissions: body.permissions,
      });
      // Wait for all queued writes to complete
      await Promise.all(writeQueue);
    } catch (error) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  });
});

// Start server
const port = Number(process.env.PORT) || 3000;
console.log(`LLM Gateway server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
