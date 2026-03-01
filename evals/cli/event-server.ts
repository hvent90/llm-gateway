/**
 * Tiny HTTP server that accepts POSTed harness events from inside
 * Docker containers and forwards them to the eval TUI.
 */
export function startEventServer(onEvent: (event: unknown) => void): {
  server: { stop(): void };
  port: number;
} {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/event") {
        return req.json().then((body) => {
          onEvent(body);
          return new Response("ok");
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port! };
}
