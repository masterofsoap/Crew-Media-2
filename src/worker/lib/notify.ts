import { newId } from "./ids";
import { pushTo } from "./realtime";

export type NotificationType =
  | "follow" | "follow_request" | "like" | "reply" | "mention" | "repost" | "quote"
  | "message" | "milestone" | "affiliate" | "system";

const BATCHED: Partial<Record<NotificationType, (postId: string | null) => string>> = {
  like: (p) => `like:${p}`,
  repost: (p) => `repost:${p}`,
  follow: () => `follow:${new Date().toISOString().slice(0, 10)}`,
};

interface NotifyInput {
  recipientId: string;
  type: NotificationType;
  actorId?: string | null;
  postId?: string | null;
  data?: Record<string, unknown>;
  /** Number of actions this call represents (batched AI follows/likes). */
  count?: number;
}

/**
 * Create (or batch into an existing unread) notification. Respects the recipient's
 * notification preferences and blocks. Never notifies a profile about its own actions.
 */
export async function notify(env: Env, n: NotifyInput) {
  if (n.actorId && n.actorId === n.recipientId) return;
  const db = env.DB;
  const recipient = await db
    .prepare(
      `SELECT notification_prefs,
        ${n.actorId ? "EXISTS(SELECT 1 FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)) OR EXISTS(SELECT 1 FROM mutes WHERE muter_id = ?1 AND muted_id = ?2)" : "0"} AS suppressed
       FROM profiles WHERE id = ?1 AND status = 'active'`,
    )
    .bind(...(n.actorId ? [n.recipientId, n.actorId] : [n.recipientId]))
    .first<{ notification_prefs: string; suppressed: number }>();
  if (!recipient || recipient.suppressed) return;
  try {
    const prefs = JSON.parse(recipient.notification_prefs || "{}") as Record<string, boolean>;
    if (prefs[n.type] === false) return;
  } catch {
    /* default: enabled */
  }

  const now = Date.now();
  const groupKey = BATCHED[n.type]?.(n.postId ?? null) ?? null;
  if (groupKey) {
    const updated = await db
      .prepare(
        `UPDATE notifications SET actor_count = actor_count + ?5, actor_id = COALESCE(?3, actor_id), updated_at = ?4
         WHERE id = (SELECT id FROM notifications WHERE recipient_id = ?1 AND group_key = ?2 AND read_at IS NULL ORDER BY updated_at DESC LIMIT 1)
         RETURNING id`,
      )
      .bind(n.recipientId, groupKey, n.actorId ?? null, now, Math.max(1, n.count ?? 1))
      .first<{ id: string }>();
    if (updated) {
      await pushTo(env, [n.recipientId], { type: "notification", profileId: n.recipientId });
      return;
    }
  }
  await db
    .prepare(
      "INSERT INTO notifications (id, recipient_id, type, actor_id, post_id, group_key, data_json, actor_count, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?8, ?8)",
    )
    .bind(newId(now), n.recipientId, n.type, n.actorId ?? null, n.postId ?? null, groupKey, JSON.stringify(n.data ?? {}), now, Math.max(1, n.count ?? 1))
    .run();
  await pushTo(env, [n.recipientId], { type: "notification", profileId: n.recipientId });
}
