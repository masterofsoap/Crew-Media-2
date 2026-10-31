import { tooMany } from "./http";

/**
 * Fixed-window counters in D1. Returns remaining budget; throws 429 when exceeded.
 * D1 is single-writer per database so the upsert is atomic.
 */
export async function hit(db: D1Database, key: string, limit: number, windowMs: number, opts: { throwOnLimit?: boolean; message?: string } = {}) {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count, blocked_until) VALUES (?1, ?2, 1, 0)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start + ?3 <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start + ?3 <= ?2 THEN ?2 ELSE rate_limits.window_start END
       RETURNING count, window_start, blocked_until`,
    )
    .bind(key, now, windowMs)
    .first<{ count: number; window_start: number; blocked_until: number }>();
  const count = row?.count ?? 1;
  const blocked = (row?.blocked_until ?? 0) > now;
  const ok = count <= limit && !blocked;
  if (!ok && opts.throwOnLimit !== false) throw tooMany(opts.message);
  return { ok, count, remaining: Math.max(0, limit - count), retryAt: blocked ? row!.blocked_until : (row?.window_start ?? now) + windowMs };
}

export async function blockKey(db: D1Database, key: string, untilMs: number) {
  await db
    .prepare("INSERT INTO rate_limits (key, window_start, count, blocked_until) VALUES (?1, ?2, 0, ?3) ON CONFLICT(key) DO UPDATE SET blocked_until = MAX(rate_limits.blocked_until, ?3)")
    .bind(key, Date.now(), untilMs)
    .run();
}

export async function isBlocked(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare("SELECT blocked_until FROM rate_limits WHERE key = ?1").bind(key).first<{ blocked_until: number }>();
  return r && r.blocked_until > Date.now() ? r.blocked_until : 0;
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
}
