import { describe, test, expect } from "bun:test";
import type { ContentPart, Message, InvokeParams, GeneratorInvokeParams } from "../types";
import type { StreamRequest } from "../client/server-event";

describe("ContentPart types", () => {
  test("TextContentPart is assignable to ContentPart", () => {
    const part: ContentPart = { type: "text", text: "hello" };
    expect(part.type).toBe("text");
  });

  test("ImageContentPart is assignable to ContentPart", () => {
    const part: ContentPart = { type: "image", mediaType: "image/png", data: "base64data" };
    expect(part.type).toBe("image");
  });

  test("DocumentContentPart is assignable to ContentPart", () => {
    const part: ContentPart = {
      type: "document",
      mediaType: "application/pdf",
      data: "base64data",
    };
    expect(part.type).toBe("document");
  });

  test("tool message accepts ContentPart[] as content", () => {
    const msg: Message = {
      role: "tool",
      tool_call_id: "tc-1",
      content: [{ type: "text", text: "result" }],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test("user message accepts ContentPart[] as content", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", mediaType: "image/png", data: "base64data" },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test("user message still accepts plain string content", () => {
    const msg: Message = { role: "user", content: "hello" };
    expect(msg.content).toBe("hello");
  });
});

describe("StreamRequest types", () => {
  test("StreamRequest accepts Message[] with ContentPart[] user content", () => {
    const req: StreamRequest = {
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", mediaType: "image/png", data: "base64data" },
          ],
        },
      ],
    };
    expect(req.messages.length).toBe(1);
    const msg = req.messages[0]!;
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
  });

  test("StreamRequest accepts Message[] with plain string user content", () => {
    const req: StreamRequest = {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    };
    expect(req.messages[0]!.content).toBe("hello");
  });

  test("StreamRequest accepts Message[] with system messages", () => {
    const req: StreamRequest = {
      model: "test-model",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    };
    expect(req.messages.length).toBe(2);
  });
});

describe("InvokeParams types", () => {
  test("context only has parentId, not runId", () => {
    // This test validates the type shape at compile time
    // If context.runId exists, this should cause a type error
    const params: InvokeParams = {
      model: "test",
      messages: [],
      emit: () => {},
      context: { parentId: "parent-123" },
    };

    const genParams: GeneratorInvokeParams = {
      model: "test",
      messages: [],
      context: { parentId: "parent-123" },
    };

    // Runtime check that context shape is correct
    expect(params.context).toEqual({ parentId: "parent-123" });
    expect(genParams.context).toEqual({ parentId: "parent-123" });
  });
});
