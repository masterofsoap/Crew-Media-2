import { newId } from "../lib/ids";

export type AiJob =
  | { kind: "agent.wake"; agentId: string; key: string }
  | { kind: "post.created"; postId: string; key: string }
  | { kind: "agent.react"; agentId: string; postId: string; intent: "reply" | "engage"; key: string }
  | { kind: "dm.reply"; agentId: string; conversationId: string; messageId: string; key: string }
  | { kind: "population.seed"; key: string }
  | { kind: "population.expand"; count: number; key: string };

export type MediaJob = { kind: "media.delete"; mediaIds: string[]; key: string };

/**
 * Enqueue with deduplication: the jobs ledger has a UNIQUE dedupe_key, so the same logical job is
 * only ever sent once. Consumers mark jobs done; redelivered messages for finished jobs are acked.
 */
export async function enqueue<T extends AiJob | MediaJob>(env: Env, queue: "ai" | "media", job: T, delaySeconds = 0): Promise<boolean> {
  const now = Date.now();
  const r = await env.DB
    .prepare("INSERT OR IGNORE INTO jobs (id, queue, kind, dedupe_key, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5)")
    .bind(newId(now), queue, job.kind, job.key, now)
    .run();
  if (r.meta.changes === 0) return false;
  const q = queue === "ai" ? env.AI_QUEUE : env.MEDIA_QUEUE;
  await q.send(job, { delaySeconds: Math.max(0, Math.min(43_200, Math.round(delaySeconds))) });
  return true;
}

export async function markJob(db: D1Database, key: string, status: "running" | "done" | "skipped" | "failed" | "dead", error?: string) {
  await db
    .prepare("UPDATE jobs SET status = ?2, attempts = attempts + (CASE WHEN ?2 = 'running' THEN 1 ELSE 0 END), last_error = COALESCE(?3, last_error), updated_at = ?4 WHERE dedupe_key = ?1")
    .bind(key, status, error ? error.slice(0, 500) : null, Date.now())
    .run();
}

export async function jobStatus(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT status FROM jobs WHERE dedupe_key = ?1").bind(key).first<{ status: string }>())?.status ?? null;
}
