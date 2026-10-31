import { Hono } from "hono";
import type { AppEnv } from "./env";
import { HttpError, forbidden } from "./lib/http";
import { auth, loadSession } from "./lib/session";
import { opsLog } from "./lib/log";
import authRoutes from "./routes/auth";
import profileRoutes from "./routes/profiles";
import socialRoutes from "./routes/social";
import postRoutes from "./routes/posts";
import feedRoutes from "./routes/feed";
import searchRoutes from "./routes/search";
import notificationRoutes from "./routes/notifications";
import mediaRoutes from "./routes/media";
import messageRoutes from "./routes/messages";
import businessRoutes from "./routes/business";
import adminRoutes from "./routes/admin";

export const app = new Hono<AppEnv>().basePath("/api");

// Security headers for every API response.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

/**
 * CSRF defense: state-changing requests must carry the custom X-Crew-Client header (which a
 * cross-site form or simple request cannot set without a CORS preflight we never grant) and, when
 * present, an Origin matching this host. Session cookies are also SameSite=Lax.
 */
app.use("*", async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    if (c.req.header("X-Crew-Client") !== "1") throw forbidden("Missing client header.");
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) throw forbidden("Cross-origin request rejected.");
  }
  const len = Number(c.req.header("Content-Length") ?? 0);
  if (!c.req.path.startsWith("/api/media") && len > 256 * 1024) throw new HttpError(413, "TOO_LARGE", "Request too large.");
  await next();
});

app.use("*", loadSession);

app.get("/health", (c) => c.json({ ok: true }));

/** WebSocket for live messages/notifications of the session's active profile. */
app.get("/realtime", async (c) => {
  const a = auth(c);
  if (c.req.header("Upgrade") !== "websocket") throw new HttpError(426, "UPGRADE_REQUIRED", "Expected WebSocket.");
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) throw forbidden();
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(a.activeProfileId));
  return stub.fetch(c.req.raw);
});

app.route("/auth", authRoutes);
app.route("/profiles", profileRoutes);
app.route("/posts", postRoutes);
app.route("/search", searchRoutes);
app.route("/notifications", notificationRoutes);
app.route("/media", mediaRoutes);
app.route("/conversations", messageRoutes);
app.route("/admin", adminRoutes);
app.route("/", feedRoutes);
app.route("/", socialRoutes);
app.route("/", businessRoutes);

app.notFound((c) => c.json({ error: "Not found.", code: "NOT_FOUND" }, 404));

app.onError(async (err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
  }
  const id = crypto.randomUUID();
  await opsLog(c.env.DB, "error", "api", "unhandled error", { id, path: c.req.path, method: c.req.method, error: String(err).slice(0, 500) });
  return c.json({ error: "Something went wrong on our side. Please try again.", code: "INTERNAL", ref: id }, 500);
});
