import type { FeedItem, MediaView, PostView, ProfileSummary } from "../../shared/types";
import { chunk, placeholders } from "./http";

/** Batched hydration helpers. Every function issues O(1) queries per batch (chunked at 90 binds). */

export const PROFILE_SUMMARY_COLS = `p.id, p.handle_display, p.display_name, p.kind, p.ai_class, p.avatar_media_id, p.avatar_seed, p.is_private, p.theme_id,
  (SELECT MAX(level) FROM milestones ms WHERE ms.profile_id = p.id) AS ms_level,
  (SELECT 1 FROM media am WHERE am.id = p.avatar_media_id AND am.status = 'ready' AND am.moderation_status <> 'removed') AS avatar_ok`;

export interface ProfileSummaryRow {
  id: string; handle_display: string; display_name: string; kind: ProfileSummary["kind"]; ai_class: ProfileSummary["aiClass"];
  avatar_media_id: string | null; avatar_seed: string; is_private: number; theme_id: string; ms_level: number | null; avatar_ok: number | null;
}

export function toSummary(r: ProfileSummaryRow): ProfileSummary {
  return {
    id: r.id,
    handle: r.handle_display,
    displayName: r.display_name,
    kind: r.kind,
    aiClass: r.ai_class,
    avatarUrl: r.avatar_media_id && r.avatar_ok ? `/api/media/${r.avatar_media_id}` : null,
    avatarSeed: r.avatar_seed,
    milestoneLevel: r.ms_level ?? 0,
    isPrivate: !!r.is_private,
    themeId: r.theme_id,
  };
}

export async function getSummaries(db: D1Database, ids: Iterable<string>): Promise<Map<string, ProfileSummary>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, ProfileSummary>();
  for (const part of chunk(unique, 90)) {
    const { results } = await db
      .prepare(`SELECT ${PROFILE_SUMMARY_COLS} FROM profiles p WHERE p.id IN (${placeholders(part.length)})`)
      .bind(...part)
      .all<ProfileSummaryRow>();
    for (const r of results) out.set(r.id, toSummary(r));
  }
  return out;
}

export async function getSummary(db: D1Database, id: string): Promise<ProfileSummary | null> {
  return (await getSummaries(db, [id])).get(id) ?? null;
}

interface MediaRow {
  id: string; post_id: string | null; message_id: string | null; kind: "image" | "video"; width: number | null; height: number | null;
  alt_text: string; status: string; moderation_status: string; expires_at: number | null; thumb_key: string | null;
}

export function toMediaView(m: MediaRow, now = Date.now()): MediaView {
  const expired = m.status === "expired" || m.status === "expiring" || (m.expires_at !== null && m.expires_at <= now);
  const removed = m.moderation_status === "removed" || m.status === "deleted" || m.status === "deleting" || m.status === "failed";
  const status: MediaView["status"] = removed ? "removed" : expired ? "expired" : "ready";
  return {
    id: m.id,
    kind: m.kind,
    url: status === "ready" ? `/api/media/${m.id}` : null,
    thumbUrl: status === "ready" && m.thumb_key ? `/api/media/${m.id}/thumb` : null,
    width: m.width,
    height: m.height,
    alt: m.alt_text,
    status,
    expiresAt: m.expires_at,
  };
}

const MEDIA_COLS = "id, post_id, message_id, kind, width, height, alt_text, status, moderation_status, expires_at, thumb_key";

export async function mediaFor(db: D1Database, column: "post_id" | "message_id", ids: string[]): Promise<Map<string, MediaView[]>> {
  const out = new Map<string, MediaView[]>();
  for (const part of chunk([...new Set(ids)], 90)) {
    if (!part.length) continue;
    const { results } = await db
      .prepare(`SELECT ${MEDIA_COLS} FROM media WHERE ${column} IN (${placeholders(part.length)}) ORDER BY created_at, id`)
      .bind(...part)
      .all<MediaRow>();
    for (const r of results) {
      const key = (column === "post_id" ? r.post_id : r.message_id)!;
      const list = out.get(key) ?? [];
      list.push(toMediaView(r));
      out.set(key, list);
    }
  }
  return out;
}

interface PostRow {
  id: string; author_id: string; text: string; reply_to_id: string | null; root_id: string | null; quote_of_id: string | null;
  ai_generated: number; like_count: number; reply_count: number; repost_count: number; quote_count: number;
  moderation_status: PostView["moderation"]; created_at: number; edited_at: number | null; deleted_at: number | null;
  is_private: number; author_status: string; vf: number; blk: number;
}

/**
 * Load and hydrate posts in the given order. Posts the viewer may not see (blocked, private
 * without follow, suspended author) are dropped unless `keepPlaceholders` is set, in which case
 * they are returned as deleted placeholders (used to keep threads coherent).
 */
export async function hydratePosts(
  db: D1Database,
  viewerId: string,
  ids: string[],
  opts: { keepPlaceholders?: boolean; depth?: number } = {},
): Promise<Map<string, PostView>> {
  const depth = opts.depth ?? 0;
  const unique = [...new Set(ids)].filter(Boolean);
  const rows: PostRow[] = [];
  for (const part of chunk(unique, 80)) {
    const { results } = await db
      .prepare(
        `SELECT p.id, p.author_id, p.text, p.reply_to_id, p.root_id, p.quote_of_id, p.ai_generated, p.like_count, p.reply_count,
                p.repost_count, p.quote_count, p.moderation_status, p.created_at, p.edited_at, p.deleted_at,
                a.is_private, a.status AS author_status,
                EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = p.author_id) AS vf,
                EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id = ?1 AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = ?1)) AS blk
         FROM posts p JOIN profiles a ON a.id = p.author_id
         WHERE p.id IN (${placeholders(part.length, 2)})`,
      )
      .bind(viewerId, ...part)
      .all<PostRow>();
    rows.push(...results);
  }

  const visible = (r: PostRow) =>
    !r.blk && r.author_status === "active" && (!r.is_private || !!r.vf || r.author_id === viewerId);

  const live = rows.filter((r) => visible(r) && !r.deleted_at && r.moderation_status !== "removed");
  const liveIds = live.map((r) => r.id);

  const [authors, media, liked, reposted, replyTo, quotes] = await Promise.all([
    getSummaries(db, rows.map((r) => r.author_id)),
    mediaFor(db, "post_id", liveIds),
    viewerSet(db, "likes", viewerId, liveIds),
    viewerSet(db, "reposts", viewerId, liveIds),
    replyHandles(db, rows.map((r) => r.reply_to_id).filter((x): x is string => !!x)),
    depth < 1
      ? hydratePosts(db, viewerId, live.map((r) => r.quote_of_id).filter((x): x is string => !!x), { keepPlaceholders: true, depth: depth + 1 })
      : Promise.resolve(new Map<string, PostView>()),
  ]);

  const out = new Map<string, PostView>();
  for (const r of rows) {
    const author = authors.get(r.author_id);
    if (!author) continue;
    const isLive = visible(r) && !r.deleted_at && r.moderation_status !== "removed";
    if (!isLive && !opts.keepPlaceholders) continue;
    out.set(r.id, {
      id: r.id,
      author,
      text: isLive ? r.text : "",
      createdAt: r.created_at,
      editedAt: r.edited_at,
      replyToId: r.reply_to_id,
      replyToHandle: r.reply_to_id ? (replyTo.get(r.reply_to_id) ?? null) : null,
      rootId: r.root_id ?? r.id,
      aiGenerated: !!r.ai_generated,
      media: isLive ? (media.get(r.id) ?? []) : [],
      quote: isLive && r.quote_of_id ? (quotes.get(r.quote_of_id) ?? null) : null,
      likeCount: r.like_count,
      replyCount: r.reply_count,
      repostCount: r.repost_count,
      quoteCount: r.quote_count,
      liked: liked.has(r.id),
      reposted: reposted.has(r.id),
      deleted: !isLive,
      moderation: r.moderation_status,
    });
  }
  return out;
}

async function viewerSet(db: D1Database, table: "likes" | "reposts", viewerId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(ids, 90)) {
    if (!part.length) continue;
    const { results } = await db
      .prepare(`SELECT post_id FROM ${table} WHERE profile_id = ?1 AND post_id IN (${placeholders(part.length, 2)})`)
      .bind(viewerId, ...part)
      .all<{ post_id: string }>();
    for (const r of results) out.add(r.post_id);
  }
  return out;
}

async function replyHandles(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk([...new Set(ids)], 90)) {
    if (!part.length) continue;
    const { results } = await db
      .prepare(`SELECT p.id, a.handle_display FROM posts p JOIN profiles a ON a.id = p.author_id WHERE p.id IN (${placeholders(part.length)})`)
      .bind(...part)
      .all<{ id: string; handle_display: string }>();
    for (const r of results) out.set(r.id, r.handle_display);
  }
  return out;
}

/** Turn ordered (postId, repostedById) entries into FeedItems, deduplicating posts. */
export async function toFeedItems(
  db: D1Database,
  viewerId: string,
  entries: { postId: string; repostedBy?: string | null; reason?: string }[],
): Promise<FeedItem[]> {
  const posts = await hydratePosts(db, viewerId, entries.map((e) => e.postId));
  const reposters = await getSummaries(db, entries.map((e) => e.repostedBy).filter((x): x is string => !!x));
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const e of entries) {
    const post = posts.get(e.postId);
    if (!post || seen.has(post.id)) continue;
    seen.add(post.id);
    items.push({ key: `${e.repostedBy ?? "p"}:${post.id}`, post, repostedBy: e.repostedBy ? (reposters.get(e.repostedBy) ?? null) : null, reason: e.reason });
  }
  return items;
}

/** SQL fragment: author `alias` is visible to viewer bound at ?1 (not blocked either way, not muted, privacy respected). */
export function visibleAuthorSql(alias: string, opts: { includeMuted?: boolean } = {}): string {
  return `${alias}.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ?1 AND b.blocked_id = ${alias}.id) OR (b.blocker_id = ${alias}.id AND b.blocked_id = ?1))
    ${opts.includeMuted ? "" : `AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = ?1 AND mu.muted_id = ${alias}.id)`}
    AND (${alias}.is_private = 0 OR ${alias}.id = ?1 OR EXISTS (SELECT 1 FROM follows vf WHERE vf.follower_id = ?1 AND vf.followee_id = ${alias}.id))`;
}

export async function isBlockedEitherWay(db: D1Database, a: string, b: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1) LIMIT 1")
    .bind(a, b)
    .first();
  return !!r;
}
