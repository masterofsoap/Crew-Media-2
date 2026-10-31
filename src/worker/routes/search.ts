import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { TOPICS } from "../../shared/constants";
import { auth } from "../lib/session";
import { decodeCursor, encodeCursor, query } from "../lib/http";
import { PROFILE_SUMMARY_COLS, toSummary, toFeedItems, visibleAuthorSql, type ProfileSummaryRow } from "../lib/views";

const app = new Hono<AppEnv>();

/** Build a safe FTS5 query: each word becomes a quoted prefix term. User input never becomes FTS syntax. */
export function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
}

/** Escape LIKE wildcards; queries use ESCAPE '!' and bound parameters. */
export function likeEscape(q: string): string {
  return q.replace(/[!%_]/g, (m) => `!${m}`);
}

app.get("/", async (c) => {
  const a = auth(c);
  const { q, type, cursor } = query(
    c,
    z.object({
      q: z.string().trim().max(100).default(""),
      type: z.enum(["top", "people", "ai", "business", "posts", "hashtags", "topics"]).default("top"),
      cursor: z.string().max(200).optional(),
    }),
  );
  const db = c.env.DB;
  const v = a.activeProfileId;
  const term = q.replace(/^[@#]/, "");
  if (!term) return c.json({ profiles: [], posts: { items: [], cursor: null }, hashtags: [], topics: [] });
  const lower = term.toLowerCase();
  const out: Record<string, unknown> = {};

  if (["top", "people", "ai", "business"].includes(type)) {
    const kindFilter =
      type === "people" ? "AND p.kind = 'personal'"
      : type === "ai" ? "AND p.kind = 'ai' AND p.ai_class = 'persona'"
      : type === "business" ? "AND p.kind = 'business'"
      : "AND (p.kind <> 'ai' OR p.ai_class = 'persona')";
    const off = decodeCursor<{ off: number }>(type !== "top" ? cursor : undefined)?.off ?? 0;
    const limit = type === "top" ? 5 : 25;
    const { results } = await db
      .prepare(
        `SELECT ${PROFILE_SUMMARY_COLS}, p.bio FROM profiles p
         WHERE (p.handle LIKE ?2 ESCAPE '!' OR p.display_name LIKE ?2 ESCAPE '!' OR p.bio LIKE ?2 ESCAPE '!') ${kindFilter}
           AND p.status = 'active' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = p.id AND b.blocked_id = ?1)
         ORDER BY (p.handle = ?3) DESC, (p.handle LIKE ?4 ESCAPE '!') DESC, p.follower_count * (0.25 + 1.5 * p.visibility / 100.0) DESC
         LIMIT ?5 OFFSET ?6`,
      )
      .bind(v, `%${likeEscape(term)}%`, lower, `${likeEscape(lower)}%`, limit, off)
      .all<ProfileSummaryRow & { bio: string }>();
    out.profiles = results.map((r) => ({ ...toSummary(r), bio: r.bio }));
    if (type !== "top") out.profilesCursor = results.length === limit ? encodeCursor({ off: off + limit }) : null;
  }

  if (type === "top" || type === "posts") {
    const fts = ftsQuery(term);
    const off = decodeCursor<{ off: number }>(type === "posts" ? cursor : undefined)?.off ?? 0;
    const limit = 20;
    let ids: string[] = [];
    if (fts) {
      const { results } = await db
        .prepare(
          `SELECT p.id FROM posts_fts JOIN posts p ON p.rowid = posts_fts.rowid JOIN profiles a ON a.id = p.author_id
           WHERE posts_fts MATCH ?2 AND p.deleted_at IS NULL AND p.moderation_status = 'ok' AND ${visibleAuthorSql("a")}
           ORDER BY (bm25(posts_fts) - p.quality_score * 2 - (0.25 + 1.5 * a.visibility / 100.0)) ASC, p.created_at DESC
           LIMIT ?3 OFFSET ?4`,
        )
        .bind(v, fts, limit, off)
        .all<{ id: string }>();
      ids = results.map((r) => r.id);
    }
    const items = await toFeedItems(db, v, ids.map((postId) => ({ postId })));
    out.posts = { items, cursor: ids.length === limit ? encodeCursor({ off: off + limit }) : null };
  }

  if (type === "top" || type === "hashtags") {
    const { results } = await db
      .prepare("SELECT tag, display, post_count FROM hashtags WHERE tag LIKE ?1 ESCAPE '!' ORDER BY post_count DESC LIMIT ?2")
      .bind(`${likeEscape(lower)}%`, type === "top" ? 5 : 30)
      .all<{ tag: string; display: string; post_count: number }>();
    out.hashtags = results.map((r) => ({ tag: r.tag, display: r.display, postCount: r.post_count }));
  }

  if (type === "top" || type === "topics") {
    out.topics = TOPICS.filter((t) => t.label.toLowerCase().includes(lower) || t.slug.includes(lower) || t.keywords.some((k) => k.includes(lower))).map((t) => ({ slug: t.slug, label: t.label }));
  }
  return c.json(out);
});

export default app;
