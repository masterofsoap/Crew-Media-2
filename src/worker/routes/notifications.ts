import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { NotificationView } from "../../shared/types";
import { actor, auth } from "../lib/session";
import { body, decodeCursor, encodeCursor, placeholders, query } from "../lib/http";
import { getSummaries } from "../lib/views";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const a = auth(c);
  const { cursor, filter } = query(c, z.object({ cursor: z.string().max(200).optional(), filter: z.enum(["all", "mentions"]).default("all") }));
  const cur = decodeCursor<[number, string]>(cursor);
  const limit = 30;
  const typeFilter = filter === "mentions" ? "AND type IN ('mention','reply','quote')" : "";
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, type, actor_id, post_id, actor_count, data_json, read_at, created_at, updated_at FROM notifications
       WHERE recipient_id = ?1 ${typeFilter} AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
       ORDER BY updated_at DESC, id DESC LIMIT ?4`,
    )
    .bind(a.activeProfileId, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", limit)
    .all<{ id: string; type: string; actor_id: string | null; post_id: string | null; actor_count: number; data_json: string; read_at: number | null; created_at: number; updated_at: number }>();
  const actors = await getSummaries(c.env.DB, results.map((r) => r.actor_id).filter((x): x is string => !!x));
  const postIds = [...new Set(results.map((r) => r.post_id).filter((x): x is string => !!x))];
  const posts = new Map<string, string>();
  if (postIds.length) {
    const { results: pr } = await c.env.DB.prepare(`SELECT id, text FROM posts WHERE id IN (${placeholders(postIds.length)}) AND deleted_at IS NULL`).bind(...postIds).all<{ id: string; text: string }>();
    for (const p of pr) posts.set(p.id, p.text);
  }
  const items: NotificationView[] = results.map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor_id ? (actors.get(r.actor_id) ?? null) : null,
    actorCount: r.actor_count,
    post: r.post_id && posts.has(r.post_id) ? { id: r.post_id, text: posts.get(r.post_id)!.slice(0, 200) } : null,
    data: JSON.parse(r.data_json || "{}") as Record<string, unknown>,
    read: !!r.read_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const last = results[results.length - 1];
  return c.json({ items, cursor: results.length === limit && last ? encodeCursor([last.updated_at, last.id]) : null });
});

app.get("/unread", async (c) => {
  const a = auth(c);
  const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ?1 AND read_at IS NULL").bind(a.activeProfileId).first<{ n: number }>();
  return c.json({ count: r?.n ?? 0 });
});

app.post("/read", async (c) => {
  const a = actor(c);
  const { ids } = await body(c, z.object({ ids: z.array(z.string().max(40)).max(100).optional() }));
  const now = Date.now();
  if (ids?.length) {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ?2 WHERE recipient_id = ?1 AND read_at IS NULL AND id IN (${placeholders(ids.length, 3)})`).bind(a.activeProfileId, now, ...ids).run();
  } else {
    await c.env.DB.prepare("UPDATE notifications SET read_at = ?2 WHERE recipient_id = ?1 AND read_at IS NULL").bind(a.activeProfileId, now).run();
  }
  return c.json({ ok: true });
});

export default app;
