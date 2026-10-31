import { MILESTONES } from "../../shared/constants";
import { notify } from "./notify";

/**
 * Award any milestones the profile now qualifies for, based on the actual follows table.
 * Idempotent: INSERT OR IGNORE on (profile_id, level). Earned milestones are never revoked.
 */
export async function awardMilestones(env: Env, profileId: string, knownCount?: number): Promise<number[]> {
  const db = env.DB;
  const cached = knownCount ?? (await db.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(profileId).first<{ follower_count: number }>())?.follower_count ?? 0;
  const lowest = MILESTONES[0]!.threshold;
  if (cached < lowest) return [];
  // Eligibility is confirmed against real relationship rows, never the cached counter alone.
  const real = (await db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?1").bind(profileId).first<{ n: number }>())?.n ?? 0;
  const awarded: number[] = [];
  const now = Date.now();
  for (const m of MILESTONES) {
    if (real < m.threshold) break;
    const r = await db
      .prepare("INSERT OR IGNORE INTO milestones (profile_id, level, threshold, follower_count_at, achieved_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(profileId, m.level, m.threshold, real, now)
      .run();
    if (r.meta.changes > 0) {
      awarded.push(m.level);
      await notify(env, { recipientId: profileId, type: "milestone", data: { level: m.level, name: m.name, threshold: m.threshold } });
    }
  }
  return awarded;
}

/** Cheap check on the hot path: only does work when a threshold was just crossed. */
export async function maybeAwardAfterFollow(env: Env, followeeId: string) {
  const row = await env.DB.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(followeeId).first<{ follower_count: number }>();
  if (!row) return;
  const crossed = MILESTONES.some((m) => row.follower_count === m.threshold || (row.follower_count > m.threshold && row.follower_count < m.threshold + 5));
  if (crossed) await awardMilestones(env, followeeId, row.follower_count);
}
