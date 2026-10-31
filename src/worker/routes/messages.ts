import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { MESSAGE_MAX_CHARS } from "../../shared/constants";
import type { ConversationView, MessageView } from "../../shared/types";
import { actor, auth } from "../lib/session";
import { bad, body, decodeCursor, encodeCursor, forbidden, notFound, placeholders, query } from "../lib/http";
import { hit } from "../lib/ratelimit";
import { getConfig } from "../lib/settings";
import { newId } from "../lib/ids";
import { getSummaries, mediaFor, isBlockedEitherWay } from "../lib/views";
import { pushTo } from "../lib/realtime";
import { notify } from "../lib/notify";
import { dmAllowed } from "./profiles";
import { enqueue } from "../jobs/queue";
import { likeEscape } from "./search";

/**
 * Deletion semantics:
 * - "Delete for me" hides a message for that profile only (message_hidden row).
 * - "Delete for everyone" (sender only) clears the text in D1 and schedules attached media for
 *   R2 deletion; a "message deleted" placeholder remains. Backups/devices outside the platform
 *   are not affected. Messages are not end-to-end encrypted.
 */
const app = new Hono<AppEnv>();

async function membership(db: D1Database, conversationId: string, profileId: string) {
  const m = await db.prepare("SELECT joined_at, last_read_at, muted, left_at FROM conversation_members WHERE conversation_id = ?1 AND profile_id = ?2").bind(conversationId, profileId).first<{ joined_at: number; last_read_at: number; muted: number; left_at: number | null }>();
  if (!m || m.left_at) throw notFound("Conversation not found.");
  return m;
}

async function members(db: D1Database, conversationId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT profile_id FROM conversation_members WHERE conversation_id = ?1 AND left_at IS NULL").bind(conversationId).all<{ profile_id: string }>();
  return results.map((r) => r.profile_id);
}

async function canStartWith(db: D1Database, senderId: string, targetId: string) {
  const [sender, t] = await Promise.all([
    db.prepare("SELECT kind FROM profiles WHERE id = ?1").bind(senderId).first<{ kind: string }>(),
    db.prepare("SELECT id, kind, dm_policy, allow_ai_dms, status, EXISTS(SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2) AS follows_sender FROM profiles WHERE id = ?1")
      .bind(targetId, senderId)
      .first<{ id: string; kind: string; dm_policy: string; allow_ai_dms: number; status: string; follows_sender: number }>(),
  ]);
  if (!t || t.status !== "active") throw notFound("That profile doesn't exist.");
  if (await isBlockedEitherWay(db, senderId, targetId)) throw forbidden("You can't message this profile.");
  if (t.kind === "ai") {
    const ai = await db.prepare("SELECT enabled FROM ai_agents WHERE profile_id = ?1").bind(targetId).first<{ enabled: number }>();
    const me = await db.prepare("SELECT allow_ai_dms FROM profiles WHERE id = ?1").bind(senderId).first<{ allow_ai_dms: number }>();
    if (!me?.allow_ai_dms) throw forbidden("Turn on “Allow AI accounts to message me” in AI preferences to chat with AI accounts.");
    if (!ai?.enabled) throw forbidden("This AI account isn't taking messages right now.");
    return;
  }
  if (!dmAllowed(t.dm_policy, !!t.follows_sender, t.kind, sender?.kind ?? "personal", !!t.allow_ai_dms)) throw forbidden("This profile only accepts messages from people they follow.");
}

async function conversationViews(db: D1Database, viewerId: string, ids: string[]): Promise<ConversationView[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(
      `SELECT c.id, c.kind, c.title, c.last_message_at, cm.last_read_at, cm.muted,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.created_at > cm.last_read_at AND m.sender_id <> ?1) AS unread
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.profile_id = ?1
       WHERE c.id IN (${placeholders(ids.length, 2)})`,
    )
    .bind(viewerId, ...ids)
    .all<{ id: string; kind: "direct" | "group"; title: string | null; last_message_at: number; last_read_at: number; muted: number; unread: number }>();
  const mem = await db
    .prepare(`SELECT conversation_id, profile_id FROM conversation_members WHERE conversation_id IN (${placeholders(ids.length)}) AND left_at IS NULL`)
    .bind(...ids)
    .all<{ conversation_id: string; profile_id: string }>();
  const lasts = await db
    .prepare(
      `SELECT m.conversation_id, m.text, m.sender_id, m.created_at, m.deleted_at, EXISTS(SELECT 1 FROM media x WHERE x.message_id = m.id) AS has_media
       FROM messages m WHERE m.id IN (SELECT (SELECT id FROM messages mm WHERE mm.conversation_id = c.id
             AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = mm.id AND h.profile_id = ?1) ORDER BY mm.created_at DESC LIMIT 1)
           FROM conversations c WHERE c.id IN (${placeholders(ids.length, 2)}))`,
    )
    .bind(viewerId, ...ids)
    .all<{ conversation_id: string; text: string | null; sender_id: string; created_at: number; deleted_at: number | null; has_media: number }>();
  const people = await getSummaries(db, mem.results.map((m) => m.profile_id));
  const lastMap = new Map(lasts.results.map((l) => [l.conversation_id, l]));
  const byId = new Map(results.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => {
      const l = lastMap.get(r.id);
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        members: mem.results.filter((m) => m.conversation_id === r.id).map((m) => people.get(m.profile_id)).filter((x): x is NonNullable<typeof x> => !!x),
        lastMessage: l ? { text: l.deleted_at ? null : l.text, senderId: l.sender_id, createdAt: l.created_at, deleted: !!l.deleted_at, hasMedia: !!l.has_media } : null,
        unread: r.unread,
        lastMessageAt: r.last_message_at,
        muted: !!r.muted,
      };
    });
}

app.get("/", async (c) => {
  const a = auth(c);
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const limit = 30;
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.last_message_at FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.profile_id = ?1 AND cm.left_at IS NULL AND (c.last_message_at < ?2 OR (c.last_message_at = ?2 AND c.id < ?3))
       ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?4`,
    )
    .bind(a.activeProfileId, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", limit)
    .all<{ id: string; last_message_at: number }>();
  const items = await conversationViews(c.env.DB, a.activeProfileId, results.map((r) => r.id));
  const last = results[results.length - 1];
  return c.json({ items, cursor: results.length === limit && last ? encodeCursor([last.last_message_at, last.id]) : null });
});

/** Open (or reuse) a direct conversation, or create a group with up to 8 other members. */
app.post("/", async (c) => {
  const a = actor(c);
  const input = await body(c, z.object({ memberIds: z.array(z.string().max(40)).min(1).max(8), title: z.string().trim().max(60).optional() }));
  const db = c.env.DB;
  const others = [...new Set(input.memberIds)].filter((x) => x !== a.activeProfileId);
  if (!others.length) throw bad("Choose someone to message.");
  await hit(db, `conv-create:${a.activeProfileId}`, 30, 3600_000);
  for (const o of others) await canStartWith(db, a.activeProfileId, o);
  const now = Date.now();
  if (others.length === 1) {
    const key = [a.activeProfileId, others[0]!].sort().join(":");
    const existing = await db.prepare("SELECT id FROM conversations WHERE direct_key = ?1").bind(key).first<{ id: string }>();
    if (existing) {
      // Re-join if this profile previously left.
      await db.prepare("UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ?1 AND profile_id = ?2").bind(existing.id, a.activeProfileId).run();
      return c.json((await conversationViews(db, a.activeProfileId, [existing.id]))[0]);
    }
    const id = newId(now);
    await db.batch([
      db.prepare("INSERT INTO conversations (id, kind, direct_key, created_by, created_at, last_message_at) VALUES (?1, 'direct', ?2, ?3, ?4, ?4)").bind(id, key, a.activeProfileId, now),
      db.prepare("INSERT INTO conversation_members (conversation_id, profile_id, joined_at, last_read_at) VALUES (?1, ?2, ?3, ?3)").bind(id, a.activeProfileId, now),
      db.prepare("INSERT INTO conversation_members (conversation_id, profile_id, joined_at, last_read_at) VALUES (?1, ?2, ?3, 0)").bind(id, others[0]!, now),
    ]);
    return c.json((await conversationViews(db, a.activeProfileId, [id]))[0], 201);
  }
  const id = newId(now);
  await db.batch([
    db.prepare("INSERT INTO conversations (id, kind, title, created_by, created_at, last_message_at) VALUES (?1, 'group', ?2, ?3, ?4, ?4)").bind(id, input.title ?? null, a.activeProfileId, now),
    db.prepare("INSERT INTO conversation_members (conversation_id, profile_id, joined_at, last_read_at) VALUES (?1, ?2, ?3, ?3)").bind(id, a.activeProfileId, now),
    ...others.map((o) => db.prepare("INSERT INTO conversation_members (conversation_id, profile_id, joined_at, last_read_at) VALUES (?1, ?2, ?3, 0)").bind(id, o, now)),
  ]);
  return c.json((await conversationViews(db, a.activeProfileId, [id]))[0], 201);
});

app.get("/search", async (c) => {
  const a = auth(c);
  const { q } = query(c, z.object({ q: z.string().trim().min(2).max(100) }));
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.profile_id = ?1 AND cm.left_at IS NULL
       WHERE m.deleted_at IS NULL AND m.created_at >= cm.joined_at AND m.text LIKE ?2 ESCAPE '!'
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.profile_id = ?1)
       ORDER BY m.created_at DESC LIMIT 30`,
    )
    .bind(a.activeProfileId, `%${likeEscape(q)}%`)
    .all<{ id: string; conversation_id: string; sender_id: string; text: string; created_at: number }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.sender_id));
  return c.json({ items: results.map((r) => ({ id: r.id, conversationId: r.conversation_id, sender: people.get(r.sender_id) ?? null, text: r.text, createdAt: r.created_at })) });
});

app.get("/:id", async (c) => {
  const a = auth(c);
  await membership(c.env.DB, c.req.param("id"), a.activeProfileId);
  const [conv] = await conversationViews(c.env.DB, a.activeProfileId, [c.req.param("id")]);
  if (!conv) throw notFound();
  return c.json(conv);
});

async function messageViews(db: D1Database, rows: { id: string; conversation_id: string; sender_id: string; text: string | null; created_at: number; deleted_at: number | null; ai_generated: number }[]): Promise<MessageView[]> {
  const people = await getSummaries(db, rows.map((r) => r.sender_id));
  const media = await mediaFor(db, "message_id", rows.filter((r) => !r.deleted_at).map((r) => r.id));
  return rows
    .filter((r) => people.has(r.sender_id))
    .map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      sender: people.get(r.sender_id)!,
      text: r.deleted_at ? null : r.text,
      media: r.deleted_at ? [] : (media.get(r.id) ?? []),
      createdAt: r.created_at,
      deleted: !!r.deleted_at,
      aiGenerated: !!r.ai_generated,
    }));
}

app.get("/:id/messages", async (c) => {
  const a = auth(c);
  const convId = c.req.param("id");
  const m = await membership(c.env.DB, convId, a.activeProfileId);
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const limit = 40;
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, conversation_id, sender_id, text, created_at, deleted_at, ai_generated FROM messages
       WHERE conversation_id = ?1 AND created_at >= ?5
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = messages.id AND h.profile_id = ?2)
         AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))
       ORDER BY created_at DESC, id DESC LIMIT ?6`,
    )
    .bind(convId, a.activeProfileId, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", m.joined_at, limit)
    .all<{ id: string; conversation_id: string; sender_id: string; text: string | null; created_at: number; deleted_at: number | null; ai_generated: number }>();
  const items = await messageViews(c.env.DB, results);
  const last = results[results.length - 1];
  return c.json({ items, cursor: results.length === limit && last ? encodeCursor([last.created_at, last.id]) : null });
});

export async function sendMessage(
  env: Env,
  input: { conversationId: string; senderId: string; text: string; mediaIds?: string[]; aiGenerated?: boolean },
): Promise<MessageView> {
  const db = env.DB;
  const text = input.text.trim();
  const mediaIds = [...new Set(input.mediaIds ?? [])];
  if (!text && !mediaIds.length) throw bad("Write a message or attach media.");
  if (text.length > MESSAGE_MAX_CHARS) throw bad(`Messages can be up to ${MESSAGE_MAX_CHARS} characters.`);
  const memberIds = await members(db, input.conversationId);
  if (!memberIds.includes(input.senderId)) throw notFound("Conversation not found.");
  // Blocks apply to direct conversations at send time.
  const conv = await db.prepare("SELECT kind FROM conversations WHERE id = ?1").bind(input.conversationId).first<{ kind: string }>();
  if (conv?.kind === "direct") {
    const other = memberIds.find((x) => x !== input.senderId);
    if (other && (await isBlockedEitherWay(db, input.senderId, other))) throw forbidden("You can't message this profile.");
  }
  const now = Date.now();
  if (mediaIds.length) {
    const { results } = await db
      .prepare(`SELECT id FROM media WHERE id IN (${placeholders(mediaIds.length, 2)}) AND owner_id = ?1 AND purpose = 'message' AND message_id IS NULL AND status = 'ready' AND expires_at > ${now}`)
      .bind(input.senderId, ...mediaIds)
      .all<{ id: string }>();
    if (results.length !== mediaIds.length) throw bad("Some attachments are missing or expired. Re-upload and try again.");
  }
  const id = newId(now);
  await db.batch([
    db.prepare("INSERT INTO messages (id, conversation_id, sender_id, text, ai_generated, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(id, input.conversationId, input.senderId, text || null, input.aiGenerated ? 1 : 0, now),
    db.prepare("UPDATE conversations SET last_message_at = ?2 WHERE id = ?1").bind(input.conversationId, now),
    db.prepare("UPDATE conversation_members SET last_read_at = ?3 WHERE conversation_id = ?1 AND profile_id = ?2").bind(input.conversationId, input.senderId, now),
    ...(mediaIds.length ? [db.prepare(`UPDATE media SET message_id = ?1, attached_at = ?2 WHERE id IN (${placeholders(mediaIds.length, 3)})`).bind(id, now, ...mediaIds)] : []),
  ]);
  const [view] = await messageViews(db, [{ id, conversation_id: input.conversationId, sender_id: input.senderId, text: text || null, created_at: now, deleted_at: null, ai_generated: input.aiGenerated ? 1 : 0 }]);
  await pushTo(env, memberIds, { type: "message", conversationId: input.conversationId, payload: view });

  // AI recipients: schedule a reply (budgeted and rate-limited in the consumer). AI accounts never DM each other.
  const { results: aiMembers } = await db
    .prepare(`SELECT a.profile_id FROM ai_agents a JOIN profiles p ON p.id = a.profile_id WHERE a.profile_id IN (${placeholders(memberIds.length)}) AND a.enabled = 1 AND p.ai_class = 'persona'`)
    .bind(...memberIds)
    .all<{ profile_id: string }>();
  if (!input.aiGenerated) {
    const sender = await db.prepare("SELECT allow_ai_dms FROM profiles WHERE id = ?1").bind(input.senderId).first<{ allow_ai_dms: number }>();
    for (const ai of aiMembers) {
      if (ai.profile_id === input.senderId || !sender?.allow_ai_dms) continue;
      await enqueue(env, "ai", { kind: "dm.reply", agentId: ai.profile_id, conversationId: input.conversationId, messageId: id, key: `dm:${id}:${ai.profile_id}` }, 5 + Math.random() * 40);
    }
  }
  // Notify (batched by conversation in the client via unread counts; one notification per unread burst).
  for (const m of memberIds) {
    if (m === input.senderId) continue;
    const muted = await db.prepare("SELECT muted FROM conversation_members WHERE conversation_id = ?1 AND profile_id = ?2").bind(input.conversationId, m).first<{ muted: number }>();
    if (muted?.muted) continue;
    const existing = await db.prepare("SELECT 1 FROM notifications WHERE recipient_id = ?1 AND type = 'message' AND read_at IS NULL AND group_key = ?2").bind(m, `msg:${input.conversationId}`).first();
    if (!existing) {
      await db
        .prepare("INSERT INTO notifications (id, recipient_id, type, actor_id, group_key, data_json, created_at, updated_at) VALUES (?1, ?2, 'message', ?3, ?4, ?5, ?6, ?6)")
        .bind(newId(now), m, input.senderId, `msg:${input.conversationId}`, JSON.stringify({ conversationId: input.conversationId }), now)
        .run();
    } else {
      await notifyTouch(db, m, input.conversationId, input.senderId, now);
    }
  }
  return view!;
}

async function notifyTouch(db: D1Database, recipient: string, convId: string, actorId: string, now: number) {
  await db.prepare("UPDATE notifications SET actor_id = ?3, actor_count = actor_count + 1, updated_at = ?4 WHERE recipient_id = ?1 AND group_key = ?2 AND read_at IS NULL").bind(recipient, `msg:${convId}`, actorId, now).run();
}

app.post("/:id/messages", async (c) => {
  const a = actor(c);
  const cfg = await getConfig(c.env.DB);
  await hit(c.env.DB, `msg:${a.activeProfileId}`, cfg.limits.messagesPerMinute, 60_000, { message: "You're sending messages too quickly." });
  const input = await body(c, z.object({ text: z.string().max(MESSAGE_MAX_CHARS * 2).default(""), mediaIds: z.array(z.string().max(40)).max(4).default([]) }));
  await membership(c.env.DB, c.req.param("id"), a.activeProfileId);
  const view = await sendMessage(c.env, { conversationId: c.req.param("id"), senderId: a.activeProfileId, text: input.text, mediaIds: input.mediaIds });
  return c.json(view, 201);
});

app.post("/:id/read", async (c) => {
  const a = actor(c);
  await membership(c.env.DB, c.req.param("id"), a.activeProfileId);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE conversation_members SET last_read_at = ?3 WHERE conversation_id = ?1 AND profile_id = ?2").bind(c.req.param("id"), a.activeProfileId, now),
    c.env.DB.prepare("UPDATE notifications SET read_at = ?3 WHERE recipient_id = ?1 AND group_key = ?2 AND read_at IS NULL").bind(a.activeProfileId, `msg:${c.req.param("id")}`, now),
  ]);
  const others = (await members(c.env.DB, c.req.param("id"))).filter((m) => m !== a.activeProfileId);
  c.executionCtx.waitUntil(pushTo(c.env, others, { type: "read", conversationId: c.req.param("id"), profileId: a.activeProfileId, payload: { at: now } }));
  return c.json({ ok: true });
});

app.post("/:id/typing", async (c) => {
  const a = actor(c);
  await membership(c.env.DB, c.req.param("id"), a.activeProfileId);
  const r = await hit(c.env.DB, `typing:${a.activeProfileId}`, 30, 60_000, { throwOnLimit: false });
  if (r.ok) {
    const others = (await members(c.env.DB, c.req.param("id"))).filter((m) => m !== a.activeProfileId);
    c.executionCtx.waitUntil(pushTo(c.env, others, { type: "typing", conversationId: c.req.param("id"), profileId: a.activeProfileId }));
  }
  return c.json({ ok: true });
});

app.patch("/:id", async (c) => {
  const a = actor(c);
  const input = await body(c, z.object({ muted: z.boolean().optional(), leave: z.boolean().optional() }));
  await membership(c.env.DB, c.req.param("id"), a.activeProfileId);
  if (input.muted !== undefined) await c.env.DB.prepare("UPDATE conversation_members SET muted = ?3 WHERE conversation_id = ?1 AND profile_id = ?2").bind(c.req.param("id"), a.activeProfileId, input.muted ? 1 : 0).run();
  if (input.leave) await c.env.DB.prepare("UPDATE conversation_members SET left_at = ?3 WHERE conversation_id = ?1 AND profile_id = ?2").bind(c.req.param("id"), a.activeProfileId, Date.now()).run();
  return c.json({ ok: true });
});

app.delete("/:id/messages/:messageId", async (c: Context<AppEnv>) => {
  const a = actor(c);
  const { scope } = query(c, z.object({ scope: z.enum(["me", "everyone"]).default("me") }));
  const convId = c.req.param("id")!;
  await membership(c.env.DB, convId, a.activeProfileId);
  const msg = await c.env.DB.prepare("SELECT id, sender_id, deleted_at FROM messages WHERE id = ?1 AND conversation_id = ?2").bind(c.req.param("messageId"), convId).first<{ id: string; sender_id: string; deleted_at: number | null }>();
  if (!msg) throw notFound();
  if (scope === "me") {
    await c.env.DB.prepare("INSERT OR IGNORE INTO message_hidden (message_id, profile_id) VALUES (?1, ?2)").bind(msg.id, a.activeProfileId).run();
    return c.json({ ok: true });
  }
  if (msg.sender_id !== a.activeProfileId) throw forbidden("You can only delete your own messages for everyone.");
  if (msg.deleted_at) return c.json({ ok: true });
  const media = (await c.env.DB.prepare("SELECT id FROM media WHERE message_id = ?1 AND status IN ('ready','expiring')").bind(msg.id).all<{ id: string }>()).results.map((r) => r.id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE messages SET text = NULL, deleted_at = ?2 WHERE id = ?1").bind(msg.id, Date.now()),
    ...(media.length ? [c.env.DB.prepare(`UPDATE media SET status = 'deleting' WHERE id IN (${placeholders(media.length)})`).bind(...media)] : []),
  ]);
  if (media.length) await enqueue(c.env, "media", { kind: "media.delete", mediaIds: media, key: `del-msg:${msg.id}` });
  c.executionCtx.waitUntil(pushTo(c.env, await members(c.env.DB, convId), { type: "message_deleted", conversationId: convId, payload: { id: msg.id } }));
  return c.json({ ok: true });
});

export { notify };
export default app;
