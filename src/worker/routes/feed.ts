import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { TOPICS } from "../../shared/constants";
import { auth } from "../lib/session";
import { decodeCursor, encodeCursor, query, notFound } from "../lib/http";
import { getConfig } from "../lib/settings";
import { scoreCandidate, diversify, type Candidate } from "../lib/ranking";
import { toFeedItems, visibleAuthorSql } from "../lib/views";
import { getTrends } from "../jobs/trends";

const app = new Hono<AppEnv>();
const PAGE = 20;

app.get("/feed/following", async (c) => {
  const a = auth(c);
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const v = a.activeProfileId;
  const { results } = await c.env.DB
    .prepare(
      `SELECT post_id, by_id, ts FROM (
         SELECT p.id AS post_id, NULL AS by_id, p.created_at AS ts FROM posts p
         WHERE (p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1) OR p.author_id = ?1)
           AND p.deleted_at IS NULL AND p.moderation_status <> 'removed'
           AND (p.reply_to_id IS NULL OR p.author_id = ?1)
         UNION ALL
         SELECT r.post_id, r.profile_id AS by_id, r.created_at AS ts FROM reposts r
         WHERE r.profile_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1)
       ) WHERE ts < ?2 OR (ts = ?2 AND post_id < ?3)
       ORDER BY ts DESC, post_id DESC LIMIT ?4`,
    )
    .bind(v, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", PAGE)
    .all<{ post_id: string; by_id: string | null; ts: number }>();
  const items = await toFeedItems(c.env.DB, v, results.map((r) => ({ postId: r.post_id, repostedBy: r.by_id })));
  const last = results[results.length - 1];
  return c.json({ items, cursor: results.length === PAGE && last ? encodeCursor([last.ts, last.post_id]) : null });
});

interface CandRow {
  id: string; author_id: string; kind: string; created_at: number; quality_score: number; topics: string; like_count: number; reply_count: number;
  repost_count: number; visibility: number; consistency: number | null; followed: number; tags: string | null; has_media: number; repliers: number;
}

/** Viewer interest profile: declared interests + topics/hashtags of recently liked and authored posts. */
async function viewerInterests(db: D1Database, viewerId: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const bump = (k: string, w: number) => m.set(k, Math.min(1, (m.get(k) ?? 0) + w));
  const me = await db.prepare("SELECT interests FROM profiles WHERE id = ?1").bind(viewerId).first<{ interests: string }>();
  for (const t of (me?.interests ?? "").split(",").filter(Boolean)) bump(t, 0.7);
  const { results } = await db
    .prepare(
      `SELECT p.topics, (SELECT group_concat(tag) FROM post_hashtags h WHERE h.post_id = p.id) AS tags, 0.08 AS w
       FROM likes l JOIN posts p ON p.id = l.post_id WHERE l.profile_id = ?1 ORDER BY l.created_at DESC LIMIT 60`,
    )
    .bind(viewerId)
    .all<{ topics: string; tags: string | null; w: number }>();
  const own = await db
    .prepare("SELECT topics, (SELECT group_concat(tag) FROM post_hashtags h WHERE h.post_id = posts.id) AS tags FROM posts WHERE author_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30")
    .bind(viewerId)
    .all<{ topics: string; tags: string | null }>();
  for (const r of results) {
    for (const t of r.topics.split(",").filter(Boolean)) bump(t, 0.08);
    for (const t of (r.tags ?? "").split(",").filter(Boolean)) bump(`#${t}`, 0.12);
  }
  for (const r of own.results) {
    for (const t of r.topics.split(",").filter(Boolean)) bump(t, 0.1);
    for (const t of (r.tags ?? "").split(",").filter(Boolean)) bump(`#${t}`, 0.15);
  }
  return m;
}

/**
 * For You: bounded candidate generation (followed + recent community posts within 4 days),
 * scored with configurable weights and the author's visibility multiplier, then diversified.
 * The cursor pins the candidate window (`at`) and offset so pages are stable.
 */
app.get("/feed/for-you", async (c) => {
  const a = auth(c);
  const { cursor } = query(c, z.object({ cursor: z.string().max(300).optional() }));
  const cur = decodeCursor<{ at: number; off: number }>(cursor) ?? { at: Date.now(), off: 0 };
  const v = a.activeProfileId;
  const db = c.env.DB;
  const cfg = await getConfig(db);
  const since = cur.at - 4 * 24 * 3600_000;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author_id, a.kind, p.created_at, p.quality_score, p.topics, p.like_count, p.reply_count, p.repost_count, a.visibility,
              s.consistency,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = p.author_id) AS followed,
              (SELECT group_concat(tag) FROM post_hashtags h WHERE h.post_id = p.id) AS tags,
              EXISTS(SELECT 1 FROM media m WHERE m.post_id = p.id) AS has_media,
              (SELECT COUNT(DISTINCT r.author_id) FROM posts r WHERE r.reply_to_id = p.id AND r.deleted_at IS NULL) AS repliers
       FROM posts p JOIN profiles a ON a.id = p.author_id LEFT JOIN profile_scores s ON s.profile_id = p.author_id
       WHERE p.created_at BETWEEN ?2 AND ?3 AND p.reply_to_id IS NULL AND p.deleted_at IS NULL AND p.moderation_status = 'ok'
         AND a.kind IN ('personal','business') AND ${visibleAuthorSql("a")}
       ORDER BY p.created_at DESC LIMIT 400`,
    )
    .bind(v, since, cur.at)
    .all<CandRow>();
  const interests = await viewerInterests(db, v);
  const inter = await db
    .prepare(
      `SELECT p.author_id, COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE l.profile_id = ?1 AND l.created_at > ?2 GROUP BY p.author_id`,
    )
    .bind(v, cur.at - 30 * 24 * 3600_000)
    .all<{ author_id: string; n: number }>();
  const interMap = new Map(inter.results.map((r) => [r.author_id, r.n]));
  const scored = results.map((r) => {
    const cand: Candidate = {
      id: r.id, authorId: r.author_id, authorIsAi: r.kind === "ai", createdAt: r.created_at, quality: r.quality_score,
      topics: r.topics.split(",").filter(Boolean), hashtags: (r.tags ?? "").split(",").filter(Boolean),
      likeCount: r.like_count, replyCount: r.reply_count, repostCount: r.repost_count, distinctRepliers: r.repliers,
      authorConsistency: r.consistency ?? 0, authorVisibility: r.visibility, followed: !!r.followed || r.author_id === v,
      interactedWithAuthor: interMap.get(r.author_id) ?? 0, hasMedia: !!r.has_media,
    };
    return { c: cand, score: scoreCandidate(cand, { interests }, cfg.ranking, cur.at) };
  });
  const ranked = diversify(scored, cur.off + PAGE);
  const page = ranked.slice(cur.off, cur.off + PAGE);
  const reasons = (x: (typeof page)[number]) => (x.c.authorId === v ? "Your post" : x.c.followed ? "Following" : x.c.topics[0] ? `Because you like ${TOPICS.find((t) => t.slug === x.c.topics[0])?.label ?? x.c.topics[0]}` : "Popular in the community");
  const items = await toFeedItems(db, v, page.map((x) => ({ postId: x.c.id, reason: reasons(x) })));
  const more = ranked.length === cur.off + PAGE && results.length > cur.off + PAGE;
  return c.json({ items, cursor: more ? encodeCursor({ at: cur.at, off: cur.off + PAGE }) : null });
});

app.get("/hashtags/:tag", async (c) => {
  const a = auth(c);
  const tag = c.req.param("tag").toLowerCase().replace(/^#/, "").slice(0, 50);
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const info = await c.env.DB.prepare("SELECT display, post_count FROM hashtags WHERE tag = ?1").bind(tag).first<{ display: string; post_count: number }>();
  if (!info && !cursor) throw notFound("No posts use that hashtag yet.");
  const { results } = await c.env.DB
    .prepare("SELECT post_id, created_at FROM post_hashtags WHERE tag = ?1 AND (created_at < ?2 OR (created_at = ?2 AND post_id < ?3)) ORDER BY created_at DESC, post_id DESC LIMIT ?4")
    .bind(tag, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", PAGE)
    .all<{ post_id: string; created_at: number }>();
  const items = await toFeedItems(c.env.DB, a.activeProfileId, results.map((r) => ({ postId: r.post_id })));
  const last = results[results.length - 1];
  return c.json({ tag: info?.display ?? tag, postCount: info?.post_count ?? 0, items, cursor: results.length === PAGE && last ? encodeCursor([last.created_at, last.post_id]) : null });
});

app.get("/trends", async (c) => {
  const a = auth(c);
  const trends = await getTrends(c.env);
  const interests = await viewerInterests(c.env.DB, a.activeProfileId);
  const forYou = trends
    .map((t) => ({ ...t, relevant: interests.has(`#${t.tag}`) || [...interests.keys()].some((k) => !k.startsWith("#") && TOPICS.find((x) => x.slug === k)?.keywords.includes(t.tag)) }))
    .filter((t) => t.relevant);
  return c.json({ platform: trends.slice(0, 10), forYou: forYou.slice(0, 5) });
});

app.get("/topics/:slug", async (c) => {
  const a = auth(c);
  const topic = TOPICS.find((t) => t.slug === c.req.param("slug"));
  if (!topic) throw notFound("Unknown topic.");
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, created_at FROM posts WHERE (',' || topics || ',') LIKE ?1 AND deleted_at IS NULL AND reply_to_id IS NULL AND moderation_status = 'ok'
       AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC LIMIT ?4`,
    )
    .bind(`%,${topic.slug},%`, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", PAGE)
    .all<{ id: string; created_at: number }>();
  const items = await toFeedItems(c.env.DB, a.activeProfileId, results.map((r) => ({ postId: r.id })));
  const last = results[results.length - 1];
  return c.json({ topic, items, cursor: results.length === PAGE && last ? encodeCursor([last.created_at, last.id]) : null });
});

export default app;
