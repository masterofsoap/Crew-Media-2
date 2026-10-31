import { DurableObject } from "cloudflare:workers";

/**
 * One ProfileHub per profile. Holds that profile's open WebSockets (hibernation API, so idle
 * sockets cost nothing) and fans out events pushed by the Worker. Clients never send data that
 * the hub trusts; all mutations go through authenticated HTTP endpoints.
 */
export class ProfileHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/push" && request.method === "POST") {
      const payload = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(payload);
        } catch {
          /* socket closing */
        }
      }
      return new Response("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closing");
    } catch {
      /* already closed */
    }
  }
}
