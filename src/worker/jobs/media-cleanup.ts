import { placeholders } from "../lib/http";
import { opsLog } from "../lib/log";
import { setFlag } from "../lib/settings";
import { enqueue, type MediaJob } from "./queue";

/**
 * Seven-day media expiry pipeline.
 *  1. expires_at = upload time + 7 days is written at upload.
 *  2. Serving re-checks expires_at on every request, so expired media is never served even if
 *     physical deletion lags.
 *  3. This hourly sweep uses the partial index idx_media_expiry to find due rows in bounded
 *     batches, marks them 'expiring', and queues deletion.
 *  4. The media queue consumer deletes R2 objects (original + thumbnail), marks rows 'expired'
 *     (or 'deleted' for post/message deletions), and retries failures with a capped attempt count;
 *     rows that keep failing become 'failed' and are surfaced in the admin media dashboard.
 */
export async function sweepExpiredMedia(env: Env) {
  const db = env.DB;
  const now = Date.now();
  let queued = 0;
  for (let round = 0; round < 5; round++) {
    const { results } = await db
      .prepare("SELECT id FROM media WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?1 ORDER BY expires_at LIMIT 100")
      .bind(now)
      .all<{ id: string }>();
    if (!results.length) break;
    const ids = results.map((r) => r.id);
    await db.prepare(`UPDATE media SET status = 'expiring' WHERE id IN (${placeholders(ids.length)}) AND status = 'ready'`).bind(...ids).run();
    await enqueue(env, "media", { kind: "media.delete", mediaIds: ids, key: `expire:${ids[0]}:${now}` });
    queued += ids.length;
  }
  // Abandoned uploads (never attached to a post/message within 24h) are removed too.
  const { results: orphans } = await db
    .prepare("SELECT id FROM media WHERE attached_at IS NULL AND status = 'ready' AND purpose <> 'profile' AND created_at < ?1 LIMIT 100")
    .bind(now - 24 * 3600_000)
    .all<{ id: string }>();
  if (orphans.length) {
    const ids = orphans.map((r) => r.id);
    await db.prepare(`UPDATE media SET status = 'deleting' WHERE id IN (${placeholders(ids.length)})`).bind(...ids).run();
    await enqueue(env, "media", { kind: "media.delete", mediaIds: ids, key: `orphan:${ids[0]}:${now}` });
  }
  // Re-queue rows stuck mid-cleanup (e.g. a lost message) after an hour.
  const { results: stuck } = await db
    .prepare("SELECT id FROM media WHERE status IN ('expiring','deleting') AND delete_attempts < 5 AND COALESCE(expires_at, created_at) < ?1 LIMIT 100")
    .bind(now - 3600_000)
    .all<{ id: string }>();
  if (stuck.length) await enqueue(env, "media", { kind: "media.delete", mediaIds: stuck.map((r) => r.id), key: `stuck:${stuck[0]!.id}:${now}` });
  const summary = { at: now, queued, orphans: orphans.length, requeued: stuck.length };
  await setFlag(db, "media_cleanup_last_run", summary);
  return summary;
}

export async function handleMediaJob(env: Env, job: MediaJob) {
  const db = env.DB;
  if (!job.mediaIds.length) return;
  const { results } = await db
    .prepare(`SELECT id, r2_key, thumb_key, status, delete_attempts FROM media WHERE id IN (${placeholders(job.mediaIds.length)}) AND status IN ('expiring','deleting','failed')`)
    .bind(...job.mediaIds)
    .all<{ id: string; r2_key: string; thumb_key: string | null; status: string; delete_attempts: number }>();
  if (!results.length) return;
  const keys = results.flatMap((r) => [r.r2_key, ...(r.thumb_key ? [r.thumb_key] : [])]);
  const now = Date.now();
  try {
    for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
    await db.batch(
      results.map((r) =>
        db.prepare("UPDATE media SET status = ?2, removed_at = ?3, last_error = NULL WHERE id = ?1").bind(r.id, r.status === "expiring" ? "expired" : "deleted", now),
      ),
    );
  } catch (e) {
    const msg = String(e).slice(0, 300);
    await db.batch(
      results.map((r) =>
        db.prepare("UPDATE media SET delete_attempts = delete_attempts + 1, last_error = ?2, status = CASE WHEN delete_attempts + 1 >= 5 THEN 'failed' ELSE status END WHERE id = ?1").bind(r.id, msg),
      ),
    );
    await opsLog(db, "error", "media.cleanup", "R2 deletion failed", { count: results.length, error: msg });
    throw e; // queue retry with backoff
  }
}

export { enqueue };
