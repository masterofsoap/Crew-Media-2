import { TOPIC_SLUGS } from "../../shared/constants";
import { AUDIENCE_FIRST, AUDIENCE_LAST } from "../ai/personas";
import { getFlag, setFlag } from "../lib/settings";
import { opsLog } from "../lib/log";
import { dayKey } from "../lib/ids";
import { enqueue } from "./queue";

/**
 * Lightweight AI audience accounts.
 *
 * Each one is a real, clearly-labeled AI profile row that never generates text. They exist so
 * earned follower growth (and the likes that come with it) is backed by genuine relationship rows.
 * They're created with set-based SQL (5,000 rows per statement) and addressed by a dense
 * `audience_slot` so growth can walk them with indexed range reads.
 *
 * Storage: ~0.6–0.8 KB per account including indexes → 1M accounts ≈ 0.7 GB (fits D1's 10 GB
 * paid limit; exceeds the 500 MB free-plan database limit).
 */

const CHUNK = 5000;
const PER_JOB = 25_000;
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

function valuesList(items: readonly string[]): string {
  return items.map((v, i) => `(${i}, ${sqlStr(v)})`).join(", ");
}

export async function audienceCount(db: D1Database): Promise<number> {
  const cached = await getFlag(db, "audience_count");
  if (cached !== null) return Number(JSON.parse(cached)) || 0;
  const r = await db.prepare("SELECT COALESCE(MAX(audience_slot), -1) + 1 AS n FROM profiles WHERE audience_slot IS NOT NULL").first<{ n: number }>();
  await setFlag(db, "audience_count", r?.n ?? 0);
  return r?.n ?? 0;
}

/** Insert up to `count` audience accounts (bounded per job; re-enqueues the remainder). */
export async function expandAudience(env: Env, count: number): Promise<number> {
  const db = env.DB;
  const todo = Math.min(count, PER_JOB);
  const nF = AUDIENCE_FIRST.length;
  const nL = AUDIENCE_LAST.length;
  const nT = TOPIC_SLUGS.length;
  let made = 0;
  for (let done = 0; done < todo; done += CHUNK) {
    const size = Math.min(CHUNK, todo - done);
    const start = (await db.prepare("SELECT COALESCE(MAX(audience_slot), -1) + 1 AS n FROM profiles WHERE audience_slot IS NOT NULL").first<{ n: number }>())?.n ?? 0;
    const now = Date.now();
    // Name/topic pools are compile-time constants, never user input. Slot-derived indexes spread
    // combinations so neighbours don't share names; created_at is spread over the past ~2 years.
    const sql = `
      WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < CAST(?1 AS INTEGER) + CAST(?2 AS INTEGER) - 1),
        f(k, v) AS (VALUES ${valuesList(AUDIENCE_FIRST)}),
        l(k, v) AS (VALUES ${valuesList(AUDIENCE_LAST)}),
        t(k, v) AS (VALUES ${valuesList(TOPIC_SLUGS)})
      INSERT OR IGNORE INTO profiles (id, handle, handle_display, display_name, bio, kind, ai_class, avatar_seed, theme_id, appearance_json,
                            interests, primary_topic, audience_slot, dm_policy, allow_ai_dms, created_at, updated_at)
      SELECT 'au' || n.i,
             lower(f.v) || '_' || lower(l.v) || '_' || n.i,
             lower(f.v) || '_' || lower(l.v) || '_' || n.i,
             f.v || ' ' || l.v,
             'AI audience account (follows and likes only).',
             'ai', 'audience', 'au' || n.i, 'aurora-borealis', '{}',
             t.v || ',' || t2.v, t.v, n.i, 'none', 0,
             CAST(?3 AS INTEGER) - ((n.i * 2654435761) % 63072000000), CAST(?3 AS INTEGER)
      FROM n
      JOIN f ON f.k = (n.i * 7 + n.i / ${nF}) % ${nF}
      JOIN l ON l.k = (n.i * 13 + n.i / ${nL * 3}) % ${nL}
      JOIN t ON t.k = (n.i * 5 + n.i / ${nT}) % ${nT}
      JOIN t AS t2 ON t2.k = (n.i * 11 + 3) % ${nT}`;
    try {
      const r = await db.prepare(sql).bind(start, size, now).run();
      made += r.meta.changes;
      await setFlag(db, "audience_count", start + size);
    } catch (e) {
      await opsLog(db, "error", "ai.population", "audience insert failed", { start, size, error: String(e).slice(0, 300) });
      throw e;
    }
  }
  if (count > todo) await enqueue(env, "ai", { kind: "population.expand", count: count - todo, key: `expand:${Date.now()}:${count - todo}` }, 2);
  await opsLog(db, "info", "ai.population", "audience expanded", { made });
  return made;
}

/**
 * Grow the pool only as far as real growth needs: the largest profile's follower count + its
 * next day's cap + headroom, bounded by the configured target.
 */
export async function ensureAudienceFor(env: Env, neededPool: number, maxPool: number) {
  const have = await audienceCount(env.DB);
  const want = Math.min(maxPool, Math.ceil(neededPool * 1.15) + 5000);
  if (have >= want) return { have, queued: 0 };
  const add = Math.min(want - have, 100_000);
  const hourKey = `${dayKey()}:${new Date().getUTCHours()}`;
  const sent = await enqueue(env, "ai", { kind: "population.expand", count: add, key: `expand:need:${hourKey}` });
  return { have, queued: sent ? add : 0 };
}
