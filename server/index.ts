import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { v7 } from "uuid";
import { AgentOrchestrator, type ConsumerHarnessEvent } from "../packages/ai/orchestrator.ts";
import { bashTool } from "../packages/ai/tools";
import type {
  GeneratorHarnessModule,
  Message,
  Permissions,
  ToolDefinition,
} from "../packages/ai/types.ts";

export interface AppConfig {
  harness?: GeneratorHarnessModule;
  tools?: ToolDefinition[];
}

interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
}

interface RelayRequest {
  sessionId: string;
  response: unknown;
}

// Serialize a ConsumerHarnessEvent to JSON-safe format, adding agentId
function serializeEvent(event: ConsumerHarnessEvent, agentId: string): object {
  if (event.type === "error") {
    return {
      type: event.type,
      runId: event.runId,
      agentId,
      ...(event.parentId && { parentId: event.parentId }),
      message: event.error.message,
    };
  }
  return { ...event, agentId };
}

export function createApp(config?: AppConfig): Hono {
  const app = new Hono();
  const tools = config?.tools ?? [bashTool];

  // Per-app orchestrator map for isolation
  const orchestrators = new Map<string, AgentOrchestrator>();

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

    // Generate session ID for this connection
    const sessionId = v7();

    return streamSSE(c, async (stream) => {
      // Create orchestrator for this session
      const orchestrator = new AgentOrchestrator(config?.harness);
      orchestrators.set(sessionId, orchestrator);

      try {
        // Send connected event with session ID
        await stream.writeSSE({
          event: "connected",
          data: JSON.stringify({ type: "connected", sessionId }),
        });

        // Spawn the agent
        const agentId = orchestrator.spawn({
          model: body.model,
          messages: body.messages,
          tools,
          permissions: body.permissions,
        });

        // Stream events from the orchestrator
        for await (const { agentId: eventAgentId, event } of orchestrator.events()) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(serializeEvent(event, eventAgentId)),
          });
        }
      } catch (error) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      } finally {
        // Clean up orchestrator when stream ends
        orchestrators.delete(sessionId);
      }
    });
  });

  app.post("/chat/relay/:relayId", async (c) => {
    let body: RelayRequest;
    try {
      body = await c.req.json<RelayRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const relayId = c.req.param("relayId");

    if (!body.sessionId || body.response === undefined) {
      return c.json({ error: "sessionId and response are required" }, 400);
    }

    const orchestrator = orchestrators.get(body.sessionId);
    if (!orchestrator) {
      return c.json({ error: "Session not found" }, 404);
    }

    const resolved = orchestrator.resolveRelay(relayId, body.response);
    if (!resolved) {
      return c.json({ error: "Relay not found" }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}

// Production app with defaults
const app = createApp();

// Start server
const port = Number(process.env.PORT) || 4000;
console.log(`LLM Gateway server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
