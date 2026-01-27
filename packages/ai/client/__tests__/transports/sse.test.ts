import { describe, test, expect, mock, afterEach } from "bun:test";
import { createSSETransport } from "../../transports/sse";

// Helper: create a ReadableStream from SSE-formatted string chunks
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// Helper: mock fetch to return an SSE stream
function mockFetch(chunks: string[], status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = mock(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      body: sseStream(chunks),
    } as Response),
  );
  return () => {
    globalThis.fetch = original;
  };
}

describe("SSE Transport", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  test("yields parsed ServerEvents from SSE stream", async () => {
    restore = mockFetch([
      'data: {"type":"connected","sessionId":"s1"}\n\n',
      'data: {"type":"text","id":"e1","runId":"r1","agentId":"a1","content":"hello"}\n\n',
    ]);

    const transport = createSSETransport({ baseUrl: "http://test" });
    const events = [];
    for await (const event of transport.stream({ model: "m", messages: [] })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "connected", sessionId: "s1" });
    expect(events[1]).toEqual({
      type: "text",
      id: "e1",
      runId: "r1",
      agentId: "a1",
      content: "hello",
    });
  });

  test("handles chunked SSE data split across reads", async () => {
    restore = mockFetch([
      'data: {"type":"text","id":"e1","runId":"r1","agentId":"a1",',
      '"content":"split"}\n\n',
    ]);

    const transport = createSSETransport({ baseUrl: "http://test" });
    const events = [];
    for await (const event of transport.stream({ model: "m", messages: [] })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "text",
      id: "e1",
      runId: "r1",
      agentId: "a1",
      content: "split",
    });
  });

  test("skips invalid JSON in SSE data", async () => {
    restore = mockFetch([
      "data: not-json\n\n",
      'data: {"type":"text","id":"e1","runId":"r1","agentId":"a1","content":"ok"}\n\n',
    ]);

    const transport = createSSETransport({ baseUrl: "http://test" });
    const events = [];
    for await (const event of transport.stream({ model: "m", messages: [] })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
  });

  test("throws on non-ok HTTP response", async () => {
    restore = mockFetch([], 500);

    const transport = createSSETransport({ baseUrl: "http://test" });
    const iter = transport.stream({ model: "m", messages: [] })[Symbol.asyncIterator]();

    expect(iter.next()).rejects.toThrow("500");
  });

  test("sends correct request to /chat endpoint", async () => {
    restore = mockFetch([]);

    const transport = createSSETransport({ baseUrl: "http://test" });
    for await (const _ of transport.stream({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    })) {
      // consume
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://test/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  test("passes abort signal to fetch", async () => {
    restore = mockFetch([]);
    const controller = new AbortController();

    const transport = createSSETransport({ baseUrl: "http://test" });
    for await (const _ of transport.stream({ model: "m", messages: [] }, controller.signal)) {
      // consume
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://test/chat",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
