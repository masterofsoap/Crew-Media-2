import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { MAX_MEDIA_PER_POST, POST_MAX_CHARS } from "../../shared/constants";
import { extractHashtags, extractMentions, inferTopics, normalizeForHash } from "../../shared/text";
import { actor, auth } from "../lib/session";
import { bad, body, decodeCursor, encodeCursor, forbidden, notFound, placeholders, query } from "../lib/http";
import { hit } from "../lib/ratelimit";
import { getConfig } from "../lib/settings";
import { newId } from "../lib/ids";
import { sha256Hex } from "../lib/crypto";
import { heuristicQuality } from "../lib/quality";
import { notify } from "../lib/notify";
import { hydratePosts, getSummaries, toFeedItems } from "../lib/views";
import { enqueue } from "../jobs/queue";
import { opsLog } from "../lib/log";

const app = new Hono<AppEnv>();

export interface CreatePostInput {
  authorId: string;
  text: string;
  mediaIds?: string[];
  replyToId?: string | null;
  quoteOfId?: string | null;
  aiGenerated?: boolean;
  createdAt?: number;
}

/**
 * Shared post-creation pipeline used by humans (HTTP) and AI agents (queue consumer).
 * Validates references, computes quality, writes post + hashtags + mentions + media attachment
 * in a single D1 batch, then fans out notifications and the AI event.
 */
export async function createPost(env: Env, input: CreatePostInput, opts: { skipAiEvent?: boolean } = {}): Promise<string> {
  const db = env.DB;
  const text = input.text.replace(/\r\n/g, "\n").trim();
  const mediaIds = [...new Set(input.mediaIds ?? [])];
  if (text.length > POST_MAX_CHARS) throw bad(`Posts can be up to ${POST_MAX_CHARS} characters.`);
  if (!text && !mediaIds.length && !input.quoteOfId) throw bad("Write something or attach media.");
  if (mediaIds.length > MAX_MEDIA_PER_POST) throw bad(`Attach up to ${MAX_MEDIA_PER_POST} files.`);
  const now = input.createdAt ?? Date.now();

  // Hard rule: only people post. AI accounts may only comment (reply) — never top-level posts,
  // quote posts or attachments — no matter which code path calls this.
  const author = await db.prepare("SELECT kind FROM profiles WHERE id = ?1").bind(input.authorId).first<{ kind: string }>();
  if (!author) throw notFound("Profile not found.");
  if (author.kind === "ai" && (!input.replyToId || input.quoteOfId || mediaIds.length)) throw forbidden("AI accounts can only comment on posts.");

  let parent: { id: string; author_id: string; root_id: string | null; thread_depth: number; deleted_at: number | null; allow_ai_replies: number } | null = null;
  if (input.replyToId) {
    parent = await db
      .prepare("SELECT p.id, p.author_id, p.root_id, p.thread_depth, p.deleted_at, a.allow_ai_replies FROM posts p JOIN profiles a ON a.id = p.author_id WHERE p.id = ?1")
      .bind(input.replyToId)
      .first();
    if (!parent || parent.deleted_at) throw notFound("The post you're replying to is gone.");
    const visible = await hydratePosts(db, input.authorId, [parent.id]);
    if (!visible.has(parent.id)) throw forbidden("You can't reply to that post.");
    if (input.aiGenerated && !parent.allow_ai_replies) throw forbidden("This author doesn't accept AI replies.");
  }
  if (input.quoteOfId) {
    const visible = await hydratePosts(db, input.authorId, [input.quoteOfId]);
    if (!visible.has(input.quoteOfId)) throw notFound("The post you're quoting isn't available.");
  }
  if (mediaIds.length) {
    const { results } = await db
      .prepare(`SELECT id FROM media WHERE id IN (${placeholders(mediaIds.length, 2)}) AND owner_id = ?1 AND purpose = 'post' AND post_id IS NULL AND status = 'ready' AND (expires_at IS NULL OR expires_at > ${now})`)
      .bind(input.authorId, ...mediaIds)
      .all<{ id: string }>();
    if (results.length !== mediaIds.length) throw bad("Some attachments are missing, expired or already used. Re-upload and try again.");
  }

  const hashtags = extractHashtags(text);
  const mentionHandles = extractMentions(text);
  const mentioned = mentionHandles.length
    ? (await db.prepare(`SELECT id, handle FROM profiles WHERE handle IN (${placeholders(mentionHandles.length)}) AND status = 'active'`).bind(...mentionHandles).all<{ id: string; handle: string }>()).results
    : [];
  const contentHash = text ? await sha256Hex(normalizeForHash(text)) : "";
  const recent = await db
    .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN content_hash = ?2 AND ?2 <> '' THEN 1 ELSE 0 END) AS dup FROM posts WHERE author_id = ?1 AND created_at > ?3 AND deleted_at IS NULL")
    .bind(input.authorId, contentHash, now - 24 * 3600_000)
    .first<{ n: number; dup: number | null }>();
  if ((recent?.dup ?? 0) > 0 && !input.replyToId) throw bad("You already posted this recently.", "DUPLICATE");

  const quality = heuristicQuality({
    text,
    mediaCount: mediaIds.length,
    hashtagCount: hashtags.length,
    mentionCount: mentioned.length,
    isReply: !!parent,
    duplicateOfRecent: (recent?.dup ?? 0) > 0,
    postsLast24h: recent?.n ?? 0,
  });
  const topics = inferTopics(`${text} ${hashtags.map((h) => `#${h.tag}`).join(" ")}`);
  const id = newId(now);
  const rootId = parent ? (parent.root_id ?? parent.id) : id;
  const depth = parent ? parent.thread_depth + 1 : 0;

  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO posts (id, author_id, text, reply_to_id, root_id, quote_of_id, thread_depth, ai_generated, quality_score, content_hash, topics, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(id, input.authorId, text, parent?.id ?? null, rootId, input.quoteOfId ?? null, depth, input.aiGenerated ? 1 : 0, quality, contentHash, topics.join(","), now),
    db.prepare("UPDATE profiles SET post_count = post_count + 1 WHERE id = ?1").bind(input.authorId),
  ];
  if (parent) stmts.push(db.prepare("UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?1").bind(parent.id));
  if (input.quoteOfId) stmts.push(db.prepare("UPDATE posts SET quote_count = quote_count + 1 WHERE id = ?1").bind(input.quoteOfId));
  for (const h of hashtags) {
    stmts.push(
      db.prepare("INSERT INTO hashtags (tag, display, post_count, last_used_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(tag) DO UPDATE SET post_count = post_count + 1, last_used_at = ?3").bind(h.tag, h.display, now),
      db.prepare("INSERT OR IGNORE INTO post_hashtags (post_id, tag, author_id, created_at) VALUES (?1, ?2, ?3, ?4)").bind(id, h.tag, input.authorId, now),
    );
  }
  for (const m of mentioned) stmts.push(db.prepare("INSERT OR IGNORE INTO mentions (post_id, profile_id) VALUES (?1, ?2)").bind(id, m.id));
  if (mediaIds.length) {
    stmts.push(db.prepare(`UPDATE media SET post_id = ?1, attached_at = ?2 WHERE id IN (${placeholders(mediaIds.length, 3)})`).bind(id, now, ...mediaIds));
  }
  await db.batch(stmts);

  // Fan-out (best-effort; failures here never undo the post).
  const jobs: Promise<unknown>[] = [];
  if (parent && parent.author_id !== input.authorId) jobs.push(notify(env, { recipientId: parent.author_id, type: "reply", actorId: input.authorId, postId: id }));
  if (input.quoteOfId) {
    const q = await db.prepare("SELECT author_id FROM posts WHERE id = ?1").bind(input.quoteOfId).first<{ author_id: string }>();
    if (q) jobs.push(notify(env, { recipientId: q.author_id, type: "quote", actorId: input.authorId, postId: id }));
  }
  for (const m of mentioned) {
    if (m.id !== parent?.author_id) jobs.push(notify(env, { recipientId: m.id, type: "mention", actorId: input.authorId, postId: id }));
  }
  if (!opts.skipAiEvent) jobs.push(enqueue(env, "ai", { kind: "post.created", postId: id, key: `post:${id}` }, 20 + Math.random() * 100));
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) if (s.status === "rejected") await opsLog(db, "warn", "posts", "post fan-out step failed", { post: id, error: String(s.reason) });
  return id;
}

app.post("/", async (c) => {
  const a = actor(c);
  const input = await body(
    c,
    z.object({
      text: z.string().max(POST_MAX_CHARS * 2).default(""),
      mediaIds: z.array(z.string().max(40)).max(MAX_MEDIA_PER_POST).default([]),
      replyToId: z.string().max(40).nullable().optional(),
      quoteOfId: z.string().max(40).nullable().optional(),
    }),
  );
  const cfg = await getConfig(c.env.DB);
  await hit(c.env.DB, `post:${a.activeProfileId}`, cfg.limits.postsPerHour, 3600_000, { message: "You're posting very quickly. Take a short break and try again." });
  const id = await createPost(c.env, { authorId: a.activeProfileId, text: input.text, mediaIds: input.mediaIds, replyToId: input.replyToId, quoteOfId: input.quoteOfId });
  const view = (await hydratePosts(c.env.DB, a.activeProfileId, [id])).get(id);
  return c.json(view, 201);
});

app.get("/:id", async (c) => {
  const a = auth(c);
  const id = c.req.param("id");
  let post = (await hydratePosts(c.env.DB, a.activeProfileId, [id])).get(id);
  if (!post) {
    // Only genuinely deleted posts get a placeholder; invisible (private/blocked) posts are a plain 404.
    const row = await c.env.DB.prepare("SELECT deleted_at, moderation_status FROM posts WHERE id = ?1").bind(id).first<{ deleted_at: number | null; moderation_status: string }>();
    if (row?.deleted_at || row?.moderation_status === "removed") post = (await hydratePosts(c.env.DB, a.activeProfileId, [id], { keepPlaceholders: true })).get(id);
  }
  if (!post) throw notFound("This post doesn't exist.");
  // Ancestors (up to 12) so the thread reads top-down.
  const ancestors: string[] = [];
  let cursor = post.replyToId;
  while (cursor && ancestors.length < 12) {
    ancestors.unshift(cursor);
    const r = await c.env.DB.prepare("SELECT reply_to_id FROM posts WHERE id = ?1").bind(cursor).first<{ reply_to_id: string | null }>();
    cursor = r?.reply_to_id ?? null;
  }
  const anc = await hydratePosts(c.env.DB, a.activeProfileId, ancestors, { keepPlaceholders: true });
  return c.json({ post, ancestors: ancestors.map((x) => anc.get(x)).filter(Boolean) });
});

app.get("/:id/replies", async (c) => {
  const a = auth(c);
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const limit = 30;
  // Replies ranked: the viewer's own and quality first within time pages would break cursors, so
  // pages are chronological; the client highlights author replies.
  const { results } = await c.env.DB
    .prepare("SELECT id, created_at FROM posts WHERE reply_to_id = ?1 AND deleted_at IS NULL AND (created_at > ?2 OR (created_at = ?2 AND id > ?3)) ORDER BY created_at, id LIMIT ?4")
    .bind(c.req.param("id"), cur?.[0] ?? 0, cur?.[1] ?? "", limit)
    .all<{ id: string; created_at: number }>();
  const map = await hydratePosts(c.env.DB, a.activeProfileId, results.map((r) => r.id));
  const last = results[results.length - 1];
  return c.json({ items: results.map((r) => map.get(r.id)).filter(Boolean), cursor: results.length === limit && last ? encodeCursor([last.created_at, last.id]) : null });
});

app.get("/:id/quotes", async (c) => {
  const a = auth(c);
  const { results } = await c.env.DB.prepare("SELECT id FROM posts WHERE quote_of_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50").bind(c.req.param("id")).all<{ id: string }>();
  return c.json({ items: await toFeedItems(c.env.DB, a.activeProfileId, results.map((r) => ({ postId: r.id }))), cursor: null });
});

app.get("/:id/likes", async (c) => {
  const a = auth(c);
  const visible = await hydratePosts(c.env.DB, a.activeProfileId, [c.req.param("id")]);
  if (!visible.size) throw notFound();
  const { results } = await c.env.DB.prepare("SELECT profile_id FROM likes WHERE post_id = ?1 ORDER BY created_at DESC LIMIT 100").bind(c.req.param("id")).all<{ profile_id: string }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.profile_id));
  return c.json({ items: results.map((r) => people.get(r.profile_id)).filter(Boolean) });
});

app.get("/:id/revisions", async (c) => {
  const a = auth(c);
  const visible = await hydratePosts(c.env.DB, a.activeProfileId, [c.req.param("id")]);
  if (!visible.size) throw notFound();
  const { results } = await c.env.DB.prepare("SELECT text, created_at FROM post_revisions WHERE post_id = ?1 ORDER BY created_at DESC").bind(c.req.param("id")).all<{ text: string; created_at: number }>();
  return c.json({ items: results.map((r) => ({ text: r.text, replacedAt: r.created_at })) });
});

app.patch("/:id", async (c) => {
  const a = actor(c);
  const { text } = await body(c, z.object({ text: z.string().trim().min(1).max(POST_MAX_CHARS) }));
  const db = c.env.DB;
  const cfg = await getConfig(db);
  const post = await db.prepare("SELECT id, author_id, text, created_at, deleted_at FROM posts WHERE id = ?1").bind(c.req.param("id")).first<{ id: string; author_id: string; text: string; created_at: number; deleted_at: number | null }>();
  if (!post || post.deleted_at) throw notFound();
  if (post.author_id !== a.activeProfileId) throw forbidden("You can only edit your own posts.");
  if (Date.now() - post.created_at > cfg.limits.editWindowMinutes * 60_000) throw bad(`Posts can be edited for ${cfg.limits.editWindowMinutes} minutes after posting.`, "EDIT_WINDOW");
  if (post.text === text) return c.json((await hydratePosts(db, a.activeProfileId, [post.id])).get(post.id));
  const now = Date.now();
  const hashtags = extractHashtags(text);
  const mentionHandles = extractMentions(text);
  const mentioned = mentionHandles.length
    ? (await db.prepare(`SELECT id FROM profiles WHERE handle IN (${placeholders(mentionHandles.length)}) AND status = 'active'`).bind(...mentionHandles).all<{ id: string }>()).results
    : [];
  const prevMentions = new Set((await db.prepare("SELECT profile_id FROM mentions WHERE post_id = ?1").bind(post.id).all<{ profile_id: string }>()).results.map((r) => r.profile_id));
  const stmts = [
    db.prepare("INSERT INTO post_revisions (id, post_id, text, created_at) VALUES (?1, ?2, ?3, ?4)").bind(newId(now), post.id, post.text, now),
    db.prepare("UPDATE posts SET text = ?2, edited_at = ?3, content_hash = ?4, topics = ?5 WHERE id = ?1").bind(post.id, text, now, await sha256Hex(normalizeForHash(text)), inferTopics(text).join(",")),
    db.prepare("DELETE FROM post_hashtags WHERE post_id = ?1").bind(post.id),
    db.prepare("DELETE FROM mentions WHERE post_id = ?1").bind(post.id),
    ...hashtags.flatMap((h) => [
      db.prepare("INSERT INTO hashtags (tag, display, post_count, last_used_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(tag) DO UPDATE SET last_used_at = ?3").bind(h.tag, h.display, now),
      db.prepare("INSERT OR IGNORE INTO post_hashtags (post_id, tag, author_id, created_at) VALUES (?1, ?2, ?3, ?4)").bind(post.id, h.tag, post.author_id, post.created_at),
    ]),
    ...mentioned.map((m) => db.prepare("INSERT OR IGNORE INTO mentions (post_id, profile_id) VALUES (?1, ?2)").bind(post.id, m.id)),
  ];
  await db.batch(stmts);
  for (const m of mentioned) if (!prevMentions.has(m.id)) await notify(c.env, { recipientId: m.id, type: "mention", actorId: a.activeProfileId, postId: post.id });
  return c.json((await hydratePosts(db, a.activeProfileId, [post.id])).get(post.id));
});

/**
 * Soft delete: the row stays (threads keep their shape) but text is cleared, it disappears from
 * feeds/search, and attached media is scheduled for physical deletion from R2.
 */
export async function deletePost(env: Env, postId: string, reason: "author" | "moderation") {
  const db = env.DB;
  const post = await db.prepare("SELECT id, author_id, reply_to_id, quote_of_id, deleted_at FROM posts WHERE id = ?1").bind(postId).first<{ id: string; author_id: string; reply_to_id: string | null; quote_of_id: string | null; deleted_at: number | null }>();
  if (!post || post.deleted_at) return;
  const now = Date.now();
  const media = (await db.prepare("SELECT id FROM media WHERE post_id = ?1 AND status IN ('ready','expiring')").bind(postId).all<{ id: string }>()).results.map((r) => r.id);
  const stmts = [
    db.prepare(`UPDATE posts SET deleted_at = ?2, text = '', moderation_status = CASE WHEN ?3 = 'moderation' THEN 'removed' ELSE moderation_status END WHERE id = ?1`).bind(postId, now, reason),
    db.prepare("UPDATE profiles SET post_count = MAX(post_count - 1, 0), pinned_post_id = CASE WHEN pinned_post_id = ?2 THEN NULL ELSE pinned_post_id END WHERE id = ?1").bind(post.author_id, postId),
    db.prepare("DELETE FROM post_hashtags WHERE post_id = ?1").bind(postId),
    db.prepare("DELETE FROM notifications WHERE post_id = ?1").bind(postId),
  ];
  if (post.reply_to_id) stmts.push(db.prepare("UPDATE posts SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?1").bind(post.reply_to_id));
  if (post.quote_of_id) stmts.push(db.prepare("UPDATE posts SET quote_count = MAX(quote_count - 1, 0) WHERE id = ?1").bind(post.quote_of_id));
  if (media.length) stmts.push(db.prepare(`UPDATE media SET status = 'deleting' WHERE id IN (${placeholders(media.length)})`).bind(...media));
  await db.batch(stmts);
  if (media.length) await enqueue(env, "media", { kind: "media.delete", mediaIds: media, key: `del-post:${postId}` });
}

app.delete("/:id", async (c) => {
  const a = actor(c);
  const post = await c.env.DB.prepare("SELECT author_id FROM posts WHERE id = ?1 AND deleted_at IS NULL").bind(c.req.param("id")).first<{ author_id: string }>();
  if (!post) throw notFound();
  if (post.author_id !== a.activeProfileId) throw forbidden("You can only delete your own posts.");
  await deletePost(c.env, c.req.param("id"), "author");
  return c.json({ ok: true });
});

async function assertVisible(env: Env, viewerId: string, postId: string) {
  const p = (await hydratePosts(env.DB, viewerId, [postId])).get(postId);
  if (!p) throw notFound("This post isn't available.");
  return p;
}

app.post("/:id/like", async (c) => {
  const a = actor(c);
  await hit(c.env.DB, `like:${a.activeProfileId}`, 600, 3600_000);
  const p = await assertVisible(c.env, a.activeProfileId, c.req.param("id"));
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO likes (profile_id, post_id, created_at) VALUES (?1, ?2, ?3)").bind(a.activeProfileId, p.id, Date.now()).run();
  if (r.meta.changes) c.executionCtx.waitUntil(notify(c.env, { recipientId: p.author.id, type: "like", actorId: a.activeProfileId, postId: p.id }));
  return c.json({ liked: true, likeCount: p.likeCount + (r.meta.changes ? 1 : 0) });
});

app.delete("/:id/like", async (c) => {
  const a = actor(c);
  const r = await c.env.DB.prepare("DELETE FROM likes WHERE profile_id = ?1 AND post_id = ?2").bind(a.activeProfileId, c.req.param("id")).run();
  const p = await c.env.DB.prepare("SELECT like_count FROM posts WHERE id = ?1").bind(c.req.param("id")).first<{ like_count: number }>();
  return c.json({ liked: false, likeCount: p?.like_count ?? 0, changed: !!r.meta.changes });
});

app.post("/:id/repost", async (c) => {
  const a = actor(c);
  await hit(c.env.DB, `repost:${a.activeProfileId}`, 200, 3600_000);
  if (a.profile.kind === "ai") throw forbidden("AI accounts can't repost.");
  const p = await assertVisible(c.env, a.activeProfileId, c.req.param("id"));
  if (p.author.isPrivate && p.author.id !== a.activeProfileId) throw bad("Posts from private profiles can't be reposted.");
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO reposts (profile_id, post_id, created_at) VALUES (?1, ?2, ?3)").bind(a.activeProfileId, p.id, Date.now()).run();
  if (r.meta.changes) c.executionCtx.waitUntil(notify(c.env, { recipientId: p.author.id, type: "repost", actorId: a.activeProfileId, postId: p.id }));
  return c.json({ reposted: true, repostCount: p.repostCount + (r.meta.changes ? 1 : 0) });
});

app.delete("/:id/repost", async (c) => {
  const a = actor(c);
  await c.env.DB.prepare("DELETE FROM reposts WHERE profile_id = ?1 AND post_id = ?2").bind(a.activeProfileId, c.req.param("id")).run();
  const p = await c.env.DB.prepare("SELECT repost_count FROM posts WHERE id = ?1").bind(c.req.param("id")).first<{ repost_count: number }>();
  return c.json({ reposted: false, repostCount: p?.repost_count ?? 0 });
});

export default app;
