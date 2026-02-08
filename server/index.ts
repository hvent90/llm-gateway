import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { v7 } from "uuid";
import {
  AgentOrchestrator,
  type ConsumerHarnessEvent,
  type ResolveResponse,
} from "../packages/ai/orchestrator.ts";
import { agentTool, bashTool, readTool, patchTool } from "../packages/ai/tools";
import { createAgentHarness } from "../packages/ai/harness/agent.ts";
import { createGeneratorHarness } from "../packages/ai/harness/providers/zen.ts";
import { createRlmHarness } from "../packages/ai/rlm/harness.ts";
import type {
  GeneratorHarnessModule,
  Message,
  Permissions,
  ToolDefinition,
} from "../packages/ai/types.ts";
import { log } from "../packages/ai/logger.ts";
import { discoverSkills, formatSkillsPrompt } from "../packages/ai/skills.ts";

export interface AppConfig {
  harness?: GeneratorHarnessModule;
  tools?: ToolDefinition[];
  defaultModel?: string;
  skillDirs?: string[];
}

interface ChatRequest {
  model: string;
  messages: Message[];
  permissions?: Permissions;
  mode?: "agent" | "rlm";
}

interface RelayRequest {
  sessionId: string;
  response: ResolveResponse;
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

export async function createApp(config?: AppConfig): Promise<Hono> {
  const app = new Hono();
  const tools = config?.tools ?? [agentTool, bashTool, readTool, patchTool];
  const harness = config?.harness ?? createAgentHarness({ harness: createGeneratorHarness() });
  const defaultModel = config?.defaultModel;
  const skills = await discoverSkills(config?.skillDirs ?? []);
  const skillsPrompt = formatSkillsPrompt(skills);

  // Per-app orchestrator map for isolation
  const orchestrators = new Map<string, AgentOrchestrator>();

  app.get("/models", async (c) => {
    const models = await harness.supportedModels();
    const validDefault = defaultModel && models.includes(defaultModel) ? defaultModel : undefined;
    return c.json({ models, ...(validDefault && { defaultModel: validDefault }) });
  });

  app.post("/chat", async (c) => {
    let body: ChatRequest;
    try {
      body = await c.req.json<ChatRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const model = body.model || defaultModel;
    if (!model || !body.messages) {
      return c.json({ error: "model and messages are required" }, 400);
    }

    // Generate session ID for this connection
    const sessionId = v7();
    const reqStart = Date.now();
    log("I", sessionId, "req_start", `model=${model}`);

    if (body.mode === "rlm") {
      return streamSSE(c, async (stream) => {
        const rlm = createRlmHarness({
          rootHarness: createGeneratorHarness(),
          config: { maxIterations: 10, maxStdoutLength: 4000, metadataPrefixLength: 200 },
        });
        const orchestrator = new AgentOrchestrator(rlm);
        orchestrators.set(sessionId, orchestrator);

        try {
          await stream.writeSSE({
            event: "connected",
            data: JSON.stringify({ type: "connected", sessionId }),
          });

          const agentId = orchestrator.spawn({
            model,
            messages: body.messages,
            permissions: body.permissions,
          });

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
          log("I", sessionId, "req_end", `dur=${Date.now() - reqStart}ms`);
          orchestrators.delete(sessionId);
        }
      });
    }

    return streamSSE(c, async (stream) => {
      // Create orchestrator for this session
      const orchestrator = new AgentOrchestrator(harness);
      orchestrators.set(sessionId, orchestrator);

      try {
        // Send connected event with session ID
        await stream.writeSSE({
          event: "connected",
          data: JSON.stringify({ type: "connected", sessionId }),
        });

        // Spawn the agent
        const messages: Message[] = skillsPrompt
          ? [{ role: "system", content: skillsPrompt }, ...body.messages]
          : body.messages;
        const agentId = orchestrator.spawn({
          model,
          messages,
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
        log("I", sessionId, "req_end", `dur=${Date.now() - reqStart}ms`);
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
const app = await createApp({
  defaultModel: process.env.DEFAULT_MODEL,
});

// Start server
const port = Number(process.env.PORT) || 4000;
console.log(`LLM Gateway server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255,
};
