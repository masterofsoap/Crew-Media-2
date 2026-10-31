/**
 * Pages Function: forward every /api/* request (including the realtime WebSocket upgrade) to the
 * crew-plus Worker through a service binding. The original request is passed through unchanged,
 * so CF-Connecting-IP, Origin/same-origin checks and cookies all behave as on the Worker's own URL.
 */
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export const onRequest = ({ request, env }: { request: Request; env: Env }) => env.API.fetch(request);
