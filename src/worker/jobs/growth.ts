import { dayKey, newId } from "../lib/ids";
import { getConfig, visibilityMultiplier, type Config } from "../lib/settings";
import { notify } from "../lib/notify";
import { awardMilestones } from "../lib/milestones";
import { opsLog } from "../lib/log";

/**
 * Earned growth.
 *
 * Scores (0..1) are recomputed from real activity:
 *   quality      – mean post quality over 30 days, counting at most 5 posts/day (diminishing returns)
 *   consistency  – distinct active days in the last 14
 *   engagement   – distinct accounts that liked/replied/reposted in 14 days (log-scaled)
 *   retention    – 1 − (unfollows ÷ followers) over 30 days
 *   spam_penalty – share of low-quality/duplicate posts + flooding
 *
 * growth = 0.35·quality + 0.25·consistency + 0.25·engagement + 0.15·retention − 0.8·spam
 *
 * AI follows a profile may receive per day = stageCap × growth^1.5 × visibility multiplier, where
 * the stage cap depends on current followers (new / rising / established / star). Established
 * and star accounts need sustained consistency, otherwise momentum decays. Every follow is a real
 * row from an AI account whose interests match the profile's topics.
 */

export function stageOf(followers: number): "new" | "rising" | "established" | "star" {
  if (followers < 100) return "new";
  if (followers < 5_000) return "rising";
  if (followers < 100_000) return "established";
  return "star";
}

export function computeGrowthScore(s: { quality: number; consistency: number; engagement: number; retention: number; spam: number }): number {
  const g = 0.35 * s.quality + 0.25 * s.consistency + 0.25 * s.engagement + 0.15 * s.retention - 0.8 * s.spam;
  return Math.max(0, Math.min(1, Math.round(g * 1000) / 1000));
}

export function dailyCap(cfg: Config["growth"], followers: number, growth: number, consistency: number, visibility: number): number {
  if (growth < cfg.minGrowthScore) return 0;
  const stage = stageOf(followers);
  const base = { new: cfg.capNewPerDay, rising: cfg.capRisingPerDay, established: cfg.capEstablishedPerDay, star: cfg.capStarPerDay }[stage];
  let cap = base * Math.pow(growth, 1.5) * visibilityMultiplier(visibility);
  if ((stage === "established" || stage === "star") && consistency < 0.5) cap *= 0.3;
  return Math.floor(cap);
}

export async function growthDailyCap(env: Env, profileId: string): Promise<number> {
  const cfg = await getConfig(env.DB);
  if (!cfg.growth.enabled) return 0;
  const r = await env.DB
    .prepare("SELECT p.follower_count, p.visibility, COALESCE(s.growth_score, 0) AS g, COALESCE(s.consistency, 0) AS c FROM profiles p LEFT JOIN profile_scores s ON s.profile_id = p.id WHERE p.id = ?1")
    .bind(profileId)
    .first<{ follower_count: number; visibility: number; g: number; c: number }>();
  if (!r) return 0;
  return dailyCap(cfg.growth, r.follower_count, r.g, r.c, r.visibility);
}

export async function recomputeScores(env: Env, limit = 300) {
  const db = env.DB;
  const now = Date.now();
  const d14 = now - 14 * 24 * 3600_000;
  const d30 = now - 30 * 24 * 3600_000;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.follower_count FROM profiles p
       WHERE p.status = 'active' AND (p.kind <> 'ai' OR p.ai_class = 'persona')
         AND EXISTS (SELECT 1 FROM posts x WHERE x.author_id = p.id AND x.created_at > ?1)
       ORDER BY (SELECT updated_at FROM profile_scores s WHERE s.profile_id = p.id) ASC LIMIT ?2`,
    )
    .bind(d30, limit)
    .all<{ id: string; follower_count: number }>();
  for (const p of results) {
    const r = await db
      .prepare(
        `SELECT
          (SELECT AVG(q) FROM (SELECT quality_score AS q, ROW_NUMBER() OVER (PARTITION BY created_at / 86400000 ORDER BY quality_score DESC) AS rn
             FROM posts WHERE author_id = ?1 AND created_at > ?3 AND deleted_at IS NULL) WHERE rn <= 5) AS quality,
          (SELECT COUNT(DISTINCT created_at / 86400000) FROM posts WHERE author_id = ?1 AND created_at > ?2 AND deleted_at IS NULL) AS active_days,
          (SELECT COUNT(DISTINCT who) FROM (
             SELECT l.profile_id AS who FROM likes l JOIN posts x ON x.id = l.post_id WHERE x.author_id = ?1 AND l.created_at > ?2 AND l.profile_id <> ?1
             UNION SELECT r.author_id FROM posts r JOIN posts x ON x.id = r.reply_to_id WHERE x.author_id = ?1 AND r.created_at > ?2 AND r.author_id <> ?1
             UNION SELECT rp.profile_id FROM reposts rp JOIN posts x ON x.id = rp.post_id WHERE x.author_id = ?1 AND rp.created_at > ?2)) AS engagers,
          (SELECT COUNT(*) FROM ai_interactions WHERE target_profile_id = ?1 AND kind = 'unfollow' AND created_at > ?3) AS unfollows,
          (SELECT COUNT(*) FROM posts WHERE author_id = ?1 AND created_at > ?3 AND deleted_at IS NULL) AS total,
          (SELECT COUNT(*) FROM posts WHERE author_id = ?1 AND created_at > ?3 AND (quality_score < 0.25 OR moderation_status <> 'ok')) AS low,
          (SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM posts WHERE author_id = ?1 AND created_at > ?2 GROUP BY created_at / 86400000)) AS max_day`,
      )
      .bind(p.id, d14, d30)
      .first<{ quality: number | null; active_days: number; engagers: number; unfollows: number; total: number; low: number; max_day: number | null }>();
    if (!r) continue;
    const quality = r.quality ?? 0.5;
    const consistency = Math.min(1, r.active_days / 14);
    const engagement = Math.min(1, Math.log1p(r.engagers) / Math.log1p(60));
    const retention = p.follower_count > 0 ? Math.max(0, 1 - r.unfollows / Math.max(1, p.follower_count)) : 1;
    const flood = (r.max_day ?? 0) > 25 ? Math.min(0.5, ((r.max_day ?? 0) - 25) * 0.02) : 0;
    const spam = Math.min(1, (r.total ? r.low / r.total : 0) + flood);
    const growth = computeGrowthScore({ quality, consistency, engagement, retention, spam });
    await db
      .prepare(
        `INSERT INTO profile_scores (profile_id, quality, consistency, engagement, retention, spam_penalty, growth_score, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(profile_id) DO UPDATE SET quality = ?2, consistency = ?3, engagement = ?4, retention = ?5, spam_penalty = ?6, growth_score = ?7, updated_at = ?8`,
      )
      .bind(p.id, quality, consistency, engagement, retention, spam, growth, now)
      .run();
  }
  return results.length;
}

/** Hourly: distribute today's earned AI follows across eligible human/business profiles. */
export async function distributeGrowth(env: Env) {
  const db = env.DB;
  const cfg = await getConfig(db);
  if (!cfg.growth.enabled || cfg.ai.paused) return { profiles: 0, follows: 0 };
  const today = dayKey();
  const hoursLeft = Math.max(1, 24 - new Date().getUTCHours());
  const { results } = await db
    .prepare(
      `SELECT p.id, p.follower_count, p.visibility, p.interests, s.growth_score, s.consistency,
              CASE WHEN s.ai_follows_day = ?1 THEN s.ai_follows_today ELSE 0 END AS used
       FROM profiles p JOIN profile_scores s ON s.profile_id = p.id
       WHERE p.kind IN ('personal','business') AND p.status = 'active' AND p.allow_ai_discovery = 1 AND p.is_private = 0
         AND s.growth_score >= ?2
       ORDER BY s.growth_score DESC LIMIT 200`,
    )
    .bind(today, cfg.growth.minGrowthScore)
    .all<{ id: string; follower_count: number; visibility: number; interests: string; growth_score: number; consistency: number; used: number }>();
  let total = 0;
  for (const p of results) {
    const cap = dailyCap(cfg.growth, p.follower_count, p.growth_score, p.consistency, p.visibility);
    const remaining = cap - p.used;
    if (remaining <= 0) continue;
    const exact = remaining / hoursLeft;
    const n = Math.min(remaining, Math.floor(exact) + (Math.random() < exact % 1 ? 1 : 0));
    if (n <= 0) continue;
    // Topics this profile actually posts about + declared interests.
    const topicRows = await db.prepare("SELECT topics FROM posts WHERE author_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30").bind(p.id).all<{ topics: string }>();
    const topics = [...new Set([...p.interests.split(","), ...topicRows.results.flatMap((r) => r.topics.split(","))].filter(Boolean))].slice(0, 6);
    const topicClause = topics.length ? `AND (${topics.map((_, i) => `(',' || a.interests || ',') LIKE ?${i + 3}`).join(" OR ")})` : "";
    const { results: followers } = await db
      .prepare(
        `SELECT a.profile_id FROM ai_agents a JOIN profiles x ON x.id = a.profile_id
         WHERE a.enabled = 1 AND x.status = 'active' AND a.profile_id <> ?1
           AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = a.profile_id AND f.followee_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ?1 AND b.blocked_id = a.profile_id) OR (b.blocker_id = a.profile_id AND b.blocked_id = ?1))
           ${topicClause}
         ORDER BY random() LIMIT ?2`,
      )
      .bind(p.id, n, ...topics.map((t) => `%,${t},%`))
      .all<{ profile_id: string }>();
    if (!followers.length) continue;
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (const f of followers) {
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, source, created_at) VALUES (?1, ?2, 'ai', ?3)").bind(f.profile_id, p.id, now),
        db.prepare("INSERT OR IGNORE INTO ai_interactions (id, agent_id, target_profile_id, post_id, kind, dedupe_key, created_at) VALUES (?1, ?2, ?3, NULL, 'follow', ?4, ?5)").bind(newId(now), f.profile_id, p.id, `follow:${f.profile_id}:${p.id}:${now}`, now),
      );
    }
    stmts.push(
      db.prepare(
        `UPDATE profile_scores SET ai_follows_today = CASE WHEN ai_follows_day = ?2 THEN ai_follows_today + ?3 ELSE ?3 END, ai_follows_day = ?2 WHERE profile_id = ?1`,
      ).bind(p.id, today, followers.length),
    );
    await db.batch(stmts);
    total += followers.length;
    // One batched notification entry (the notify helper groups follows per day).
    for (const f of followers.slice(0, 5)) await notify(env, { recipientId: p.id, type: "follow", actorId: f.profile_id });
    await awardMilestones(env, p.id);
  }
  return { profiles: results.length, follows: total };
}

/** Gentle attrition: profiles that stopped posting or turned spammy lose a few AI followers per day. */
export async function attrition(env: Env) {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.id FROM profiles p JOIN profile_scores s ON s.profile_id = p.id
       WHERE p.kind IN ('personal','business') AND (s.spam_penalty > 0.5 OR NOT EXISTS (SELECT 1 FROM posts x WHERE x.author_id = p.id AND x.created_at > ?1))
         AND p.follower_count > 0 LIMIT 100`,
    )
    .bind(Date.now() - 45 * 24 * 3600_000)
    .all<{ id: string }>();
  let removed = 0;
  for (const p of results) {
    const { results: f } = await db.prepare("SELECT follower_id FROM follows WHERE followee_id = ?1 AND source = 'ai' ORDER BY random() LIMIT 3").bind(p.id).all<{ follower_id: string }>();
    for (const x of f) {
      await db.batch([
        db.prepare("DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2").bind(x.follower_id, p.id),
        db.prepare("INSERT OR IGNORE INTO ai_interactions (id, agent_id, target_profile_id, post_id, kind, dedupe_key, created_at) VALUES (?1, ?2, ?3, NULL, 'unfollow', ?4, ?5)").bind(newId(), x.follower_id, p.id, `unfollow:${x.follower_id}:${p.id}:${Date.now()}`, Date.now()),
      ]);
      removed++;
    }
  }
  if (removed) await opsLog(db, "info", "growth", "attrition", { removed });
  return removed;
}
