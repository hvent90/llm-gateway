import { describe, test, expect, mock, afterEach } from "bun:test";
import { createHTTPTransport } from "../../transports/http";

describe("HTTP Transport", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  test("resolveRelay sends POST to /chat/relay/:relayId", async () => {
    originalFetch = globalThis.fetch;
    const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const transport = createHTTPTransport({ baseUrl: "http://test" });
    await transport.resolveRelay("sess-1", "relay-1", { approved: true });

    expect(mockFetch).toHaveBeenCalledWith("http://test/chat/relay/relay-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-1", response: { approved: true } }),
    });
  });

  test("resolveRelay sends arbitrary response payload", async () => {
    originalFetch = globalThis.fetch;
    const mockFetch = mock(() => Promise.resolve({ ok: true } as Response));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const transport = createHTTPTransport({ baseUrl: "http://test" });
    await transport.resolveRelay("sess-1", "relay-2", { approved: false, reason: "Denied" });

    expect(mockFetch).toHaveBeenCalledWith("http://test/chat/relay/relay-2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-1",
        response: { approved: false, reason: "Denied" },
      }),
    });
  });

  test("resolveRelay throws on non-ok response", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 404, statusText: "Not Found" } as Response),
    ) as unknown as typeof fetch;

    const transport = createHTTPTransport({ baseUrl: "http://test" });
    expect(transport.resolveRelay("sess-1", "relay-1", { approved: true })).rejects.toThrow("404");
  });
});
