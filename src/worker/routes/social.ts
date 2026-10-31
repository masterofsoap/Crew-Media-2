import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { REPORT_REASONS } from "../../shared/constants";
import { actor, auth } from "../lib/session";
import { bad, body, notFound } from "../lib/http";
import { hit } from "../lib/ratelimit";
import { getConfig } from "../lib/settings";
import { notify } from "../lib/notify";
import { maybeAwardAfterFollow } from "../lib/milestones";
import { getSummaries } from "../lib/views";
import { isBlockedEitherWay } from "../lib/views";
import { newId } from "../lib/ids";

const app = new Hono<AppEnv>();

async function target(db: D1Database, id: string) {
  const t = await db.prepare("SELECT id, is_private, status, kind FROM profiles WHERE id = ?1").bind(id).first<{ id: string; is_private: number; status: string; kind: string }>();
  if (!t || t.status !== "active") throw notFound("That profile doesn't exist.");
  return t;
}

app.post("/follows/:id", async (c) => {
  const a = actor(c);
  const id = c.req.param("id");
  if (id === a.activeProfileId) throw bad("You can't follow yourself.");
  const cfg = await getConfig(c.env.DB);
  await hit(c.env.DB, `follow:${a.activeProfileId}`, cfg.limits.followsPerHour, 3600_000);
  const t = await target(c.env.DB, id);
  if (await isBlockedEitherWay(c.env.DB, a.activeProfileId, id)) throw bad("You can't follow this profile.", "BLOCKED");
  const now = Date.now();
  if (t.is_private) {
    const already = await c.env.DB.prepare("SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2").bind(a.activeProfileId, id).first();
    if (already) return c.json({ state: "following" });
    const r = await c.env.DB.prepare("INSERT OR IGNORE INTO follow_requests (requester_id, target_id, created_at) VALUES (?1, ?2, ?3)").bind(a.activeProfileId, id, now).run();
    if (r.meta.changes) await notify(c.env, { recipientId: id, type: "follow_request", actorId: a.activeProfileId });
    return c.json({ state: "requested" });
  }
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, source, created_at) VALUES (?1, ?2, 'human', ?3)").bind(a.activeProfileId, id, now).run();
  if (r.meta.changes) {
    c.executionCtx.waitUntil(Promise.all([notify(c.env, { recipientId: id, type: "follow", actorId: a.activeProfileId }), maybeAwardAfterFollow(c.env, id)]));
  }
  return c.json({ state: "following" });
});

app.delete("/follows/:id", async (c) => {
  const a = actor(c);
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2").bind(a.activeProfileId, id),
    c.env.DB.prepare("DELETE FROM follow_requests WHERE requester_id = ?1 AND target_id = ?2").bind(a.activeProfileId, id),
  ]);
  return c.json({ state: "none" });
});

/** Remove a follower from your own profile. */
app.delete("/followers/:id", async (c) => {
  const a = actor(c);
  await c.env.DB.prepare("DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2").bind(c.req.param("id"), a.activeProfileId).run();
  return c.json({ ok: true });
});

app.get("/follow-requests", async (c) => {
  const a = auth(c);
  const { results } = await c.env.DB.prepare("SELECT requester_id, created_at FROM follow_requests WHERE target_id = ?1 ORDER BY created_at DESC LIMIT 100")
    .bind(a.activeProfileId)
    .all<{ requester_id: string; created_at: number }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.requester_id));
  return c.json({ items: results.filter((r) => people.has(r.requester_id)).map((r) => ({ profile: people.get(r.requester_id)!, createdAt: r.created_at })) });
});

app.post("/follow-requests/:id/:decision{approve|decline}", async (c) => {
  const a = actor(c);
  const requester = c.req.param("id");
  const del = await c.env.DB.prepare("DELETE FROM follow_requests WHERE requester_id = ?1 AND target_id = ?2").bind(requester, a.activeProfileId).run();
  if (!del.meta.changes) throw notFound("That request no longer exists.");
  if (c.req.param("decision") === "approve") {
    const r = await c.env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, source, created_at) VALUES (?1, ?2, 'human', ?3)").bind(requester, a.activeProfileId, Date.now()).run();
    if (r.meta.changes) await maybeAwardAfterFollow(c.env, a.activeProfileId);
    await notify(c.env, { recipientId: requester, type: "system", actorId: a.activeProfileId, data: { message: "approved your follow request" } });
  }
  return c.json({ ok: true });
});

app.post("/blocks/:id", async (c) => {
  const a = actor(c);
  const id = c.req.param("id");
  if (id === a.activeProfileId) throw bad("You can't block yourself.");
  await target(c.env.DB, id);
  const db = c.env.DB;
  // Blocking severs follows and pending requests in both directions.
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?1, ?2, ?3)").bind(a.activeProfileId, id, Date.now()),
    db.prepare("DELETE FROM follows WHERE (follower_id = ?1 AND followee_id = ?2) OR (follower_id = ?2 AND followee_id = ?1)").bind(a.activeProfileId, id),
    db.prepare("DELETE FROM follow_requests WHERE (requester_id = ?1 AND target_id = ?2) OR (requester_id = ?2 AND target_id = ?1)").bind(a.activeProfileId, id),
  ]);
  return c.json({ blocking: true });
});

app.delete("/blocks/:id", async (c) => {
  const a = actor(c);
  await c.env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2").bind(a.activeProfileId, c.req.param("id")).run();
  return c.json({ blocking: false });
});

app.post("/mutes/:id", async (c) => {
  const a = actor(c);
  const id = c.req.param("id");
  if (id === a.activeProfileId) throw bad("You can't mute yourself.");
  await target(c.env.DB, id);
  await c.env.DB.prepare("INSERT OR IGNORE INTO mutes (muter_id, muted_id, created_at) VALUES (?1, ?2, ?3)").bind(a.activeProfileId, id, Date.now()).run();
  return c.json({ muting: true });
});

app.delete("/mutes/:id", async (c) => {
  const a = actor(c);
  await c.env.DB.prepare("DELETE FROM mutes WHERE muter_id = ?1 AND muted_id = ?2").bind(a.activeProfileId, c.req.param("id")).run();
  return c.json({ muting: false });
});

app.get("/:list{blocks|mutes}", async (c) => {
  const a = auth(c);
  const isBlocks = c.req.param("list") === "blocks";
  const sql = isBlocks
    ? "SELECT blocked_id AS pid FROM blocks WHERE blocker_id = ?1 ORDER BY created_at DESC LIMIT 200"
    : "SELECT muted_id AS pid FROM mutes WHERE muter_id = ?1 ORDER BY created_at DESC LIMIT 200";
  const { results } = await c.env.DB.prepare(sql).bind(a.activeProfileId).all<{ pid: string }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.pid));
  return c.json({ items: results.map((r) => people.get(r.pid)).filter(Boolean) });
});

app.post("/reports", async (c) => {
  const a = actor(c);
  const input = await body(
    c,
    z.object({
      targetType: z.enum(["post", "profile", "message", "media"]),
      targetId: z.string().min(1).max(40),
      reason: z.enum(REPORT_REASONS),
      details: z.string().max(1000).default(""),
    }),
  );
  await hit(c.env.DB, `report:${a.activeProfileId}`, 20, 3600_000);
  const db = c.env.DB;
  // A reporter can only report things they can actually access.
  const exists =
    input.targetType === "post"
      ? await db.prepare("SELECT 1 FROM posts WHERE id = ?1").bind(input.targetId).first()
      : input.targetType === "profile"
        ? await db.prepare("SELECT 1 FROM profiles WHERE id = ?1").bind(input.targetId).first()
        : input.targetType === "message"
          ? await db.prepare("SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.profile_id = ?2 WHERE m.id = ?1").bind(input.targetId, a.activeProfileId).first()
          : await db.prepare("SELECT 1 FROM media WHERE id = ?1").bind(input.targetId).first();
  if (!exists) throw notFound("We couldn't find what you're reporting.");
  await db
    .prepare("INSERT OR IGNORE INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(newId(), a.activeProfileId, input.targetType, input.targetId, input.reason, input.details, Date.now())
    .run();
  return c.json({ ok: true }, 201);
});

export default app;
