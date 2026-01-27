/**
 * Create an HTTP transport for client→server commands.
 */
export function createHTTPTransport(config: { baseUrl: string }) {
  const { baseUrl } = config;

  return {
    /**
     * Resolve a pending relay request.
     *
     * @param sessionId The session that owns the relay
     * @param relayId The relay event ID to resolve
     * @param response The response payload (shape depends on relay kind)
     */
    async resolveRelay(sessionId: string, relayId: string, response: unknown): Promise<void> {
      const res = await fetch(`${baseUrl}/chat/relay/${relayId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, response }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
    },
  };
}
