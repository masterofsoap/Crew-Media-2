import { MILESTONES } from "../../shared/constants";
import { dayKey } from "../lib/ids";
import { getConfig, visibilityMultiplier, type Config } from "../lib/settings";
import { notify } from "../lib/notify";
import { awardMilestones } from "../lib/milestones";
import { opsLog } from "../lib/log";
import { audienceCount, ensureAudienceFor } from "./audience";

/**
 * Earned growth.
 *
 * Scores (0..1) are recomputed from real activity:
 *   quality      – mean post quality over 30 days, counting at most 5 posts/day (diminishing returns)
 *   consistency  – distinct active days in the last 14
 *   engagement   – distinct accounts that liked/replied/reposted in 14 days (log-scaled)
 *   retention    – 1 − (AI followers lost ÷ followers) over ~30 days
 *   spam_penalty – share of low-quality/duplicate posts + flooding
 *
 * growth = 0.35·quality + 0.25·consistency + 0.25·engagement + 0.15·retention − 0.8·spam
 *
 * Daily AI-follow allowance compounds like real audiences do:
 *   < 100 followers      newPerDay (flat)
 *   100 – 5k             followers × risingRate      (2%/day)
 *   5k – 100k            followers × establishedRate (1.5%/day)
 *   100k – 1M            followers × starRate        (1%/day)
 *   > 1M                 followers × megaRate        (0.2%/day)
 * × growth^1.5 × visibility multiplier, ×0.3 for large accounts posting inconsistently, and never
 * past aiFollowerCeiling. At a perfect score that's roughly 2 years from 0 to 1M; at a typical good
 * score (≈0.6) closer to 4–5 years. Momentum must be sustained — a viral week does not compound.
 */

export type Stage = "new" | "rising" | "established" | "star" | "mega";

export function stageOf(followers: number): Stage {
  if (followers < 100) return "new";
  if (followers < 5_000) return "rising";
  if (followers < 100_000) return "established";
  if (followers < 1_000_000) return "star";
  return "mega";
}

export function computeGrowthScore(s: { quality: number; consistency: number; engagement: number; retention: number; spam: number }): number {
  const g = 0.35 * s.quality + 0.25 * s.consistency + 0.25 * s.engagement + 0.15 * s.retention - 0.8 * s.spam;
  return Math.max(0, Math.min(1, Math.round(g * 1000) / 1000));
}

export function dailyCap(cfg: Config["growth"], followers: number, growth: number, consistency: number, visibility: number, aiFollowers = followers): number {
  if (growth < cfg.minGrowthScore) return 0;
  const stage = stageOf(followers);
  const rate = { new: 0, rising: cfg.risingRate, established: cfg.establishedRate, star: cfg.starRate, mega: cfg.megaRate }[stage];
  const base = Math.max(cfg.newPerDay, followers * rate);
  let cap = base * Math.pow(growth, 1.5) * visibilityMultiplier(visibility);
  if (stage !== "new" && stage !== "rising" && consistency < 0.5) cap *= 0.3;
  return Math.max(0, Math.min(Math.floor(cap), cfg.aiFollowerCeiling - aiFollowers));
}

/** Rough projection used in docs/tests: days to go from `from` to `to` at a constant score. */
export function projectDays(cfg: Config["growth"], from: number, to: number, growth: number, consistency = 1, visibility = 50): number {
  let f = from;
  let days = 0;
  while (f < to && days < 20_000) {
    const add = dailyCap(cfg, f, growth, consistency, visibility, f);
    if (add <= 0) return Infinity;
    f += add;
    days++;
  }
  return days;
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
  // Driven from recent posts (indexed by time), so a million silent audience rows are never scanned.
  const { results } = await db
    .prepare(
      `SELECT p.id, p.follower_count, COALESCE(s.churn_30d, 0) AS churn FROM profiles p
       LEFT JOIN profile_scores s ON s.profile_id = p.id
       WHERE p.id IN (SELECT DISTINCT author_id FROM posts WHERE created_at > ?1) AND p.status = 'active'
       ORDER BY COALESCE(s.updated_at, 0) ASC LIMIT ?2`,
    )
    .bind(d30, limit)
    .all<{ id: string; follower_count: number; churn: number }>();
  for (const p of results) {
    const r = await db
      .prepare(
        `SELECT
          (SELECT AVG(q) FROM (SELECT quality_score AS q, ROW_NUMBER() OVER (PARTITION BY created_at / 86400000 ORDER BY quality_score DESC) AS rn
             FROM posts WHERE author_id = ?1 AND created_at > ?3 AND deleted_at IS NULL) WHERE rn <= 5) AS quality,
          (SELECT COUNT(DISTINCT created_at / 86400000) FROM posts WHERE author_id = ?1 AND created_at > ?2 AND deleted_at IS NULL) AS active_days,
          (SELECT COUNT(DISTINCT who) FROM (
             SELECT l.profile_id AS who FROM likes l JOIN posts x ON x.id = l.post_id WHERE x.author_id = ?1 AND l.created_at > ?2 AND l.profile_id <> ?1 AND l.profile_id NOT LIKE 'au%'
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
    // Audience likes are excluded above so the audience can't inflate the engagement it is rewarded for.
    const engagement = Math.min(1, Math.log1p(r.engagers) / Math.log1p(60));
    const lost = r.unfollows + p.churn;
    const retention = p.follower_count > 0 ? Math.max(0, 1 - (lost / Math.max(1, p.follower_count)) * 10) : 1;
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

function crossedMilestone(before: number, after: number) {
  return MILESTONES.some((m) => before < m.threshold && after >= m.threshold);
}

/**
 * Hourly: hand out this hour's share of each eligible profile's daily allowance.
 * Followers come from the audience ring: each profile walks its own cursor (starting at a random
 * slot) through a window of 3× the needed size, preferring accounts whose topic matches what the
 * profile posts about. One indexed INSERT…SELECT per profile; no random scans.
 */
export async function distributeGrowth(env: Env) {
  const db = env.DB;
  const cfg = await getConfig(db);
  if (!cfg.growth.enabled || cfg.ai.paused) return { profiles: 0, follows: 0 };
  const today = dayKey();
  const hoursLeft = Math.max(1, 24 - new Date().getUTCHours());
  const { results } = await db
    .prepare(
      `SELECT p.id, p.follower_count, p.visibility, p.interests, s.growth_score, s.consistency, s.audience_cursor,
              CASE WHEN s.ai_follows_day = ?1 THEN s.ai_follows_today ELSE 0 END AS used
       FROM profiles p JOIN profile_scores s ON s.profile_id = p.id
       WHERE p.kind IN ('personal','business') AND p.status = 'active' AND p.allow_ai_discovery = 1 AND p.is_private = 0
         AND s.growth_score >= ?2
       ORDER BY s.growth_score DESC LIMIT 300`,
    )
    .bind(today, cfg.growth.minGrowthScore)
    .all<{ id: string; follower_count: number; visibility: number; interests: string; growth_score: number; consistency: number; audience_cursor: number; used: number }>();
  if (!results.length) return { profiles: 0, follows: 0 };

  // Make sure the pool can cover the biggest profile plus a day of growth (bounded by the target).
  const biggest = results.reduce((m, p) => Math.max(m, p.follower_count + dailyCap(cfg.growth, p.follower_count, p.growth_score, p.consistency, p.visibility)), 0);
  await ensureAudienceFor(env, biggest, cfg.growth.audienceTarget);
  const pool = await audienceCount(db);
  if (pool === 0) return { profiles: results.length, follows: 0, note: "audience pool empty (expansion queued)" };

  let total = 0;
  for (const p of results) {
    const cap = dailyCap(cfg.growth, p.follower_count, p.growth_score, p.consistency, p.visibility);
    const remaining = cap - p.used;
    if (remaining <= 0) continue;
    const exact = remaining / hoursLeft;
    const n = Math.min(remaining, 5000, Math.floor(exact) + (Math.random() < exact % 1 ? 1 : 0));
    if (n <= 0) continue;

    const topicRows = await db.prepare("SELECT topics FROM posts WHERE author_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30").bind(p.id).all<{ topics: string }>();
    const topics = [...new Set([...p.interests.split(","), ...topicRows.results.flatMap((r) => r.topics.split(","))].filter(Boolean))].slice(0, 6);
    const topicSql = topics.length ? `CASE WHEN a.primary_topic IN (${topics.map((_, i) => `?${i + 7}`).join(",")}) THEN 0 ELSE 1 END,` : "";
    // Window size adapts to how much of the pool already follows this profile, so dense regions
    // (a 900k-follower account in a 1.1M pool) still find enough new followers per pass.
    const density = Math.min(0.95, p.follower_count / pool);
    let cursor = p.audience_cursor >= 0 && p.audience_cursor < pool ? p.audience_cursor : Math.floor(Math.random() * pool);
    let added = 0;
    // Windows grow ×4 per attempt so a long run of existing followers ahead of the cursor (e.g.
    // after wrapping the ring) is crossed quickly while each pass stays bounded.
    for (let attempt = 0; attempt < 6 && added < n; attempt++) {
      const window = Math.min(pool, Math.max(60, Math.ceil(((n - added) * 3) / (1 - density)) * 4 ** attempt), 250_000);
      const end = cursor + window;
      const wrapEnd = end > pool ? end - pool : -1;
      await db
        .prepare(
          `INSERT OR IGNORE INTO follows (follower_id, followee_id, source, created_at)
           SELECT a.id, ?1, 'ai', ?2 FROM profiles a
           WHERE ((a.audience_slot >= ?3 AND a.audience_slot < ?4) OR a.audience_slot < ?5) AND a.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = a.id AND f.followee_id = ?1)
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = ?1 AND b.blocked_id = a.id)
           ORDER BY ${topicSql} a.audience_slot
           LIMIT ?6`,
        )
        .bind(p.id, Date.now(), cursor, Math.min(end, pool), wrapEnd, n - added, ...topics)
        .run();

      added = ((await db.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(p.id).first<{ follower_count: number }>())?.follower_count ?? p.follower_count) - p.follower_count;
      cursor = end % pool;
      if (window >= pool) break;
    }
    await db
      .prepare(
        `UPDATE profile_scores SET audience_cursor = ?4,
           ai_follows_today = CASE WHEN ai_follows_day = ?2 THEN ai_follows_today + ?3 ELSE ?3 END, ai_follows_day = ?2
         WHERE profile_id = ?1`,
      )
      .bind(p.id, today, added, cursor)
      .run();
    if (!added) continue;
    total += added;
    const sample = await db.prepare("SELECT follower_id FROM follows WHERE followee_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(p.id).first<{ follower_id: string }>();
    await notify(env, { recipientId: p.id, type: "follow", actorId: sample?.follower_id ?? null, count: added });
    if (crossedMilestone(p.follower_count, p.follower_count + added)) await awardMilestones(env, p.id);
  }
  return { profiles: results.length, follows: total, pool };
}

/**
 * Hourly: audience followers like recent posts in proportion to the author's reach and the post's
 * quality, front-loaded over ~2 days (like real engagement curves). Likers are drawn from the
 * author's own AI audience followers via an indexed offset window.
 */
export async function audienceEngagement(env: Env) {
  const db = env.DB;
  const cfg = await getConfig(db);
  if (!cfg.growth.enabled || cfg.ai.paused) return { posts: 0, likes: 0 };
  const now = Date.now();
  const { results } = await db
    .prepare(
      `SELECT p.id, p.author_id, p.created_at, p.quality_score, p.audience_likes, a.follower_count, a.visibility
       FROM posts p JOIN profiles a ON a.id = p.author_id
       WHERE p.created_at > ?1 AND p.reply_to_id IS NULL AND p.deleted_at IS NULL AND p.moderation_status = 'ok'
         AND a.kind IN ('personal','business') AND a.status = 'active' AND a.is_private = 0 AND a.allow_ai_discovery = 1 AND a.follower_count >= 20
       ORDER BY p.created_at DESC LIMIT 400`,
    )
    .bind(now - 48 * 3600_000)
    .all<{ id: string; author_id: string; created_at: number; quality_score: number; audience_likes: number; follower_count: number; visibility: number }>();
  let likes = 0;
  for (const p of results) {
    const rate = (cfg.growth.likeRateBase + cfg.growth.likeRateQualityBonus * p.quality_score ** 2) * visibilityMultiplier(p.visibility);
    const target = Math.floor(p.follower_count * rate);
    const ageH = (now - p.created_at) / 3600_000;
    const desired = Math.floor(target * (1 - Math.exp(-ageH / 8)));
    const delta = Math.min(desired - p.audience_likes, 2000);
    if (delta <= 0) continue;
    const offset = Math.floor(Math.random() * Math.max(1, p.follower_count - delta));
    const likesBefore = (await db.prepare("SELECT like_count FROM posts WHERE id = ?1").bind(p.id).first<{ like_count: number }>())?.like_count ?? 0;
    await db
      .prepare(
        `INSERT OR IGNORE INTO likes (profile_id, post_id, created_at)
         SELECT follower_id, ?2, ?3 FROM (
           SELECT follower_id FROM follows WHERE followee_id = ?1 AND source = 'ai' AND follower_id LIKE 'au%' LIMIT ?4 OFFSET ?5
         )`,
      )
      .bind(p.author_id, p.id, now, delta, offset)
      .run();
    // meta.changes would include trigger-maintained counter rows; derive the real number instead.
    const added = ((await db.prepare("SELECT like_count FROM posts WHERE id = ?1").bind(p.id).first<{ like_count: number }>())?.like_count ?? likesBefore) - likesBefore;
    // Count attempted likes too, so a post with few remaining unliked followers stops retrying.
    await db.prepare("UPDATE posts SET audience_likes = audience_likes + ?2 WHERE id = ?1").bind(p.id, Math.max(added, delta)).run();
    if (added) {
      likes += added;
      const liker = await db.prepare("SELECT profile_id FROM likes WHERE post_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(p.id).first<{ profile_id: string }>();
      await notify(env, { recipientId: p.author_id, type: "like", postId: p.id, actorId: liker?.profile_id ?? null, count: added });
    }
  }
  return { posts: results.length, likes };
}

/**
 * Attrition: real audiences churn. Healthy profiles lose ~0.02%/day, inactive (45d) ~0.5%/day,
 * spammy ~1%/day — always real deletions of AI follow rows, recorded in churn_30d.
 */
export async function attrition(env: Env) {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.follower_count, s.spam_penalty,
              EXISTS (SELECT 1 FROM posts x WHERE x.author_id = p.id AND x.created_at > ?1) AS active
       FROM profiles p JOIN profile_scores s ON s.profile_id = p.id
       WHERE p.kind IN ('personal','business') AND p.follower_count > 0 LIMIT 500`,
    )
    .bind(Date.now() - 45 * 24 * 3600_000)
    .all<{ id: string; follower_count: number; spam_penalty: number; active: number }>();
  let removed = 0;
  for (const p of results) {
    const daily = p.spam_penalty > 0.5 ? 0.01 : !p.active ? 0.005 : 0.0002;
    const exact = (p.follower_count * daily) / 24; // runs hourly
    const n = Math.min(2000, Math.floor(exact) + (Math.random() < exact % 1 ? 1 : 0));
    if (n <= 0) continue;
    const offset = Math.floor(Math.random() * Math.max(1, p.follower_count - n));
    await db
      .prepare(
        `DELETE FROM follows WHERE followee_id = ?1 AND follower_id IN (
           SELECT follower_id FROM follows WHERE followee_id = ?1 AND source = 'ai' AND follower_id LIKE 'au%' LIMIT ?2 OFFSET ?3)`,
      )
      .bind(p.id, n, offset)
      .run();
    const gone = p.follower_count - ((await db.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(p.id).first<{ follower_count: number }>())?.follower_count ?? p.follower_count);
    if (gone) {
      removed += gone;
      await db.prepare("UPDATE profile_scores SET churn_30d = churn_30d + ?2 WHERE profile_id = ?1").bind(p.id, gone).run();
    }
  }
  if (removed) await opsLog(db, "info", "growth", "attrition", { removed });
  return removed;
}
