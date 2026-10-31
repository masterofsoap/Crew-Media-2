import type { TrendView } from "../../shared/types";

/**
 * Trends = hashtags with unusual recent discussion, measured by distinct authors (not raw post
 * volume), weighted by author quality, compared against a 7-day baseline. Accounts repeating a
 * tag count once, and tags carried only by AI accounts are damped so coordinated bursts can't
 * manufacture a trend.
 */
export async function computeTrends(env: Env): Promise<TrendView[]> {
  const db = env.DB;
  const now = Date.now();
  const { results } = await db
    .prepare(
      `WITH recent AS (
         SELECT h.tag, h.author_id, MAX(COALESCE(s.quality, 0.5)) AS q, MAX(CASE WHEN a.kind = 'ai' THEN 1 ELSE 0 END) AS is_ai, COUNT(*) AS n
         FROM post_hashtags h JOIN profiles a ON a.id = h.author_id LEFT JOIN profile_scores s ON s.profile_id = h.author_id
         JOIN posts p ON p.id = h.post_id
         WHERE h.created_at > ?1 AND p.deleted_at IS NULL AND p.moderation_status = 'ok' AND a.status = 'active' AND a.is_private = 0
         GROUP BY h.tag, h.author_id
       ),
       baseline AS (
         SELECT tag, COUNT(DISTINCT author_id) AS authors FROM post_hashtags WHERE created_at BETWEEN ?2 AND ?1 GROUP BY tag
       )
       SELECT r.tag, SUM(r.n) AS posts, COUNT(*) AS authors, SUM(r.q * (CASE WHEN r.is_ai = 1 THEN 0.5 ELSE 1.0 END)) AS weighted,
              SUM(1 - r.is_ai) AS human_authors, COALESCE(b.authors, 0) AS base
       FROM recent r LEFT JOIN baseline b ON b.tag = r.tag
       GROUP BY r.tag HAVING COUNT(*) >= 2
       ORDER BY weighted DESC LIMIT 60`,
    )
    .bind(now - 24 * 3600_000, now - 8 * 24 * 3600_000)
    .all<{ tag: string; posts: number; authors: number; weighted: number; human_authors: number; base: number }>();
  const scored = results
    .map((r) => {
      const novelty = (r.authors + 1) / (r.base / 7 + 1);
      const humanBoost = r.human_authors > 0 ? 1 : 0.6;
      return { tag: r.tag, postCount: r.posts, authorCount: r.authors, score: Math.round(r.weighted * Math.sqrt(novelty) * humanBoost * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  const stmts = [db.prepare("DELETE FROM trends")];
  for (const t of scored) {
    stmts.push(db.prepare("INSERT INTO trends (tag, score, post_count, author_count, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(t.tag, t.score, t.postCount, t.authorCount, now));
  }
  await db.batch(stmts);
  await env.CACHE.put("trends:v1", JSON.stringify({ at: now, items: scored }), { expirationTtl: 3600 });
  return scored;
}

export async function getTrends(env: Env): Promise<TrendView[]> {
  const cached = await env.CACHE.get<{ at: number; items: TrendView[] }>("trends:v1", "json");
  if (cached && Date.now() - cached.at < 20 * 60_000) return cached.items;
  const { results } = await env.DB.prepare("SELECT tag, score, post_count, author_count, computed_at FROM trends ORDER BY score DESC LIMIT 30").all<{ tag: string; score: number; post_count: number; author_count: number; computed_at: number }>();
  if (!results.length || Date.now() - results[0]!.computed_at > 30 * 60_000) return computeTrends(env);
  return results.map((r) => ({ tag: r.tag, score: r.score, postCount: r.post_count, authorCount: r.author_count }));
}
