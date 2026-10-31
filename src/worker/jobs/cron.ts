import { getConfig, getFlag } from "../lib/settings";
import { opsLog } from "../lib/log";
import { dayKey } from "../lib/ids";
import { awardMilestones } from "../lib/milestones";
import { MILESTONES } from "../../shared/constants";
import { enqueue } from "./queue";
import { sweepExpiredMedia } from "./media-cleanup";
import { computeTrends } from "./trends";
import { attrition, distributeGrowth, recomputeScores } from "./growth";
import { budgetState } from "../ai/provider";

export type MaintenanceTask = "media-cleanup" | "reconcile" | "trends" | "growth" | "ai-tick" | "prune";

/**
 * AI tick (every 5 minutes): wake a bounded number of due personas. Work is spread with random
 * queue delays; each agent has a per-day action cap; the whole system respects the daily budget
 * and the emergency pause. With N agents the cost is bounded by agentsPerTick, not by N.
 */
export async function aiTick(env: Env) {
  const db = env.DB;
  const cfg = await getConfig(db, true);
  if (!(await getFlag(db, "ai_seeded"))) {
    await enqueue(env, "ai", { kind: "population.seed", key: "seed:initial" });
    return { woke: 0, note: "seeding" };
  }
  if (cfg.ai.paused) return { woke: 0, note: "paused" };
  const budget = await budgetState(db, cfg);
  // Reset agents stuck in queued/active (lost messages) after 30 minutes.
  await db.prepare("UPDATE ai_agents SET state = 'idle' WHERE state IN ('queued','active') AND COALESCE(last_active_at, 0) < ?1 AND next_wake_at < ?1").bind(Date.now() - 30 * 60_000).run();
  const slots = Math.min(cfg.ai.agentsPerTick, budget.ok ? Math.max(1, Math.floor(budget.remainingCalls / 4)) : 0);
  if (slots <= 0) return { woke: 0, note: "budget" };
  const { results } = await db
    .prepare(
      `SELECT a.profile_id FROM ai_agents a JOIN profiles p ON p.id = a.profile_id
       WHERE a.enabled = 1 AND a.state = 'idle' AND p.ai_class = 'persona' AND p.status = 'active' AND a.next_wake_at <= ?1
       ORDER BY a.next_wake_at LIMIT ?2`,
    )
    .bind(Date.now(), Math.min(slots, cfg.ai.maxActivePersonas))
    .all<{ profile_id: string }>();
  let woke = 0;
  const slot = Math.floor(Date.now() / (5 * 60_000));
  for (const r of results) {
    await db.prepare("UPDATE ai_agents SET state = 'queued' WHERE profile_id = ?1").bind(r.profile_id).run();
    if (await enqueue(env, "ai", { kind: "agent.wake", agentId: r.profile_id, key: `wake:${r.profile_id}:${slot}` }, Math.random() * 270)) woke++;
  }
  return { woke };
}

/** Re-derive cached counters from relationship tables for a bounded sample; award milestones from real rows. */
export async function reconcile(env: Env) {
  const db = env.DB;
  const { results } = await db
    .prepare("SELECT id FROM profiles WHERE counts_dirty = 1 OR follower_count >= ?1 OR id IN (SELECT id FROM profiles ORDER BY random() LIMIT 100) LIMIT 300")
    .bind(MILESTONES[0]!.threshold)
    .all<{ id: string }>();
  let fixed = 0;
  for (const { id } of results) {
    const r = await db
      .prepare(
        `UPDATE profiles SET
           follower_count = (SELECT COUNT(*) FROM follows WHERE followee_id = ?1),
           following_count = (SELECT COUNT(*) FROM follows WHERE follower_id = ?1),
           post_count = (SELECT COUNT(*) FROM posts WHERE author_id = ?1 AND deleted_at IS NULL),
           counts_dirty = 0
         WHERE id = ?1 AND (follower_count <> (SELECT COUNT(*) FROM follows WHERE followee_id = ?1)
           OR following_count <> (SELECT COUNT(*) FROM follows WHERE follower_id = ?1)
           OR post_count <> (SELECT COUNT(*) FROM posts WHERE author_id = ?1 AND deleted_at IS NULL) OR counts_dirty = 1)
         RETURNING follower_count`,
      )
      .bind(id)
      .first<{ follower_count: number }>();
    if (r) fixed++;
    await awardMilestones(env, id);
  }
  // Post counters for recent posts.
  await db
    .prepare(
      `UPDATE posts SET
         like_count = (SELECT COUNT(*) FROM likes WHERE post_id = posts.id),
         repost_count = (SELECT COUNT(*) FROM reposts WHERE post_id = posts.id),
         reply_count = (SELECT COUNT(*) FROM posts r WHERE r.reply_to_id = posts.id AND r.deleted_at IS NULL),
         quote_count = (SELECT COUNT(*) FROM posts q WHERE q.quote_of_id = posts.id AND q.deleted_at IS NULL)
       WHERE created_at > ?1`,
    )
    .bind(Date.now() - 3 * 24 * 3600_000)
    .run();
  if (fixed) await opsLog(db, "warn", "reconcile", "corrected cached counts", { profiles: fixed });
  return { checked: results.length, fixed };
}

export async function prune(env: Env) {
  const db = env.DB;
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?1 AND blocked_until < ?2").bind(now - 2 * 24 * 3600_000, now),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    db.prepare("DELETE FROM recovery_tokens WHERE expires_at < ?1").bind(now - 7 * 24 * 3600_000),
    db.prepare("DELETE FROM jobs WHERE status IN ('done','skipped') AND updated_at < ?1").bind(now - 14 * 24 * 3600_000),
    db.prepare("DELETE FROM ops_log WHERE created_at < ?1").bind(now - 30 * 24 * 3600_000),
    db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND updated_at < ?1").bind(now - 90 * 24 * 3600_000),
    db.prepare("DELETE FROM ai_interactions WHERE kind IN ('skip') AND created_at < ?1").bind(now - 30 * 24 * 3600_000),
    // Memory retention: keep each agent's 80 most important/recent memories.
    db.prepare(
      `DELETE FROM ai_memories WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY weight DESC, COALESCE(last_used_at, created_at) DESC) AS rn FROM ai_memories) WHERE rn > 80)`,
    ),
  ]);
  // Grow the audience pool toward the configured target in bounded steps.
  const cfg = await getConfig(db);
  const audience = (await db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE kind = 'ai' AND ai_class = 'audience'").first<{ n: number }>())?.n ?? 0;
  const gap = cfg.growth.audienceTarget - audience;
  if (gap > 0) await enqueue(env, "ai", { kind: "population.expand", count: Math.min(gap, 5000), key: `expand:auto:${dayKey()}` });
  return { pruned: true, audienceGap: Math.max(0, gap) };
}

export async function runMaintenance(env: Env, task: MaintenanceTask): Promise<unknown> {
  switch (task) {
    case "media-cleanup":
      return sweepExpiredMedia(env);
    case "reconcile":
      return reconcile(env);
    case "trends":
      return (await computeTrends(env)).length;
    case "growth": {
      const scored = await recomputeScores(env);
      const dist = await distributeGrowth(env);
      const removed = await attrition(env);
      return { scored, ...dist, attrition: removed };
    }
    case "ai-tick":
      return aiTick(env);
    case "prune":
      return prune(env);
  }
}

export async function scheduled(controller: ScheduledController, env: Env) {
  const tasks: MaintenanceTask[] =
    controller.cron === "*/5 * * * *" ? ["ai-tick"]
    : controller.cron === "17 * * * *" ? ["media-cleanup", "trends", "growth", "reconcile"]
    : ["prune"];
  for (const t of tasks) {
    try {
      await runMaintenance(env, t);
    } catch (e) {
      await opsLog(env.DB, "error", `cron.${t}`, "scheduled task failed", { error: String(e).slice(0, 500) });
    }
  }
}
