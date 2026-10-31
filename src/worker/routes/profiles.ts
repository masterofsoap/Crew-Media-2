import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { BIO_MAX_CHARS, DISPLAY_NAME_MAX, MILESTONES, PROFILES_PER_IDENTITY, TOPIC_SLUGS } from "../../shared/constants";
import { normalizeHandle } from "../../shared/text";
import { appearanceSchema, parseAppearance } from "../../shared/appearance";
import type { AffiliationView, FeedItem, ProfileDetail, ProfileSummary } from "../../shared/types";
import { actor, auth } from "../lib/session";
import { bad, body, decodeCursor, encodeCursor, forbidden, notFound, query } from "../lib/http";
import { assertHandleAvailable, createProfileStatements, sessionInfo } from "../lib/profiles";
import { getSummaries, toFeedItems, visibleAuthorSql, PROFILE_SUMMARY_COLS, toSummary, type ProfileSummaryRow } from "../lib/views";
import { visibilityMultiplier } from "../lib/settings";
import { hit } from "../lib/ratelimit";

const app = new Hono<AppEnv>();

interface ProfileRow extends ProfileSummaryRow {
  bio: string; location: string; website: string; banner_media_id: string | null; appearance_json: string;
  follower_count: number; following_count: number; post_count: number; created_at: number; pinned_post_id: string | null;
  likes_public: number; interests: string; status: string; dm_policy: string; allow_ai_dms: number; banner_ok: number | null;
}

async function findProfile(db: D1Database, handle: string): Promise<ProfileRow | null> {
  return db
    .prepare(
      `SELECT ${PROFILE_SUMMARY_COLS}, p.bio, p.location, p.website, p.banner_media_id, p.appearance_json, p.follower_count, p.following_count,
              p.post_count, p.created_at, p.pinned_post_id, p.likes_public, p.interests, p.status, p.dm_policy, p.allow_ai_dms,
              (SELECT 1 FROM media bm WHERE bm.id = p.banner_media_id AND bm.status = 'ready' AND bm.moderation_status <> 'removed') AS banner_ok
       FROM profiles p WHERE p.handle = ?1`,
    )
    .bind(normalizeHandle(handle))
    .first<ProfileRow>();
}

export async function relationship(db: D1Database, viewerId: string, targetId: string) {
  const r = await db
    .prepare(
      `SELECT
        EXISTS(SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = ?2) AS following,
        EXISTS(SELECT 1 FROM follows WHERE follower_id = ?2 AND followee_id = ?1) AS followed_by,
        EXISTS(SELECT 1 FROM follow_requests WHERE requester_id = ?1 AND target_id = ?2) AS requested,
        EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ?1 AND blocked_id = ?2) AS blocking,
        EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ?2 AND blocked_id = ?1) AS blocked_by,
        EXISTS(SELECT 1 FROM mutes WHERE muter_id = ?1 AND muted_id = ?2) AS muting`,
    )
    .bind(viewerId, targetId)
    .first<{ following: number; followed_by: number; requested: number; blocking: number; blocked_by: number; muting: number }>();
  return {
    following: !!r?.following,
    followedBy: !!r?.followed_by,
    requested: !!r?.requested,
    blocking: !!r?.blocking,
    blockedBy: !!r?.blocked_by,
    muting: !!r?.muting,
  };
}

/** Whether `sender` may start a DM with `target` under the target's policy. */
export function dmAllowed(policy: string, targetFollowsSender: boolean, targetKind: string, senderKind: string, targetAllowsAi: boolean) {
  if (senderKind === "ai" && !targetAllowsAi) return false;
  if (targetKind === "ai") return true;
  if (policy === "everyone") return true;
  if (policy === "following") return targetFollowsSender;
  return false;
}

export async function affiliationsFor(db: D1Database, profileId: string, includePending = false): Promise<AffiliationView[]> {
  const { results } = await db
    .prepare(
      `SELECT id, business_id, affiliate_id, relation_type, status, requested_by, created_at FROM affiliations
       WHERE (business_id = ?1 OR affiliate_id = ?1) AND status IN ${includePending ? "('pending','accepted')" : "('accepted')"}
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(profileId)
    .all<{ id: string; business_id: string; affiliate_id: string; relation_type: string; status: AffiliationView["status"]; requested_by: string; created_at: number }>();
  const people = await getSummaries(db, results.flatMap((r) => [r.business_id, r.affiliate_id]));
  return results
    .filter((r) => people.has(r.business_id) && people.has(r.affiliate_id))
    .map((r) => ({ id: r.id, relationType: r.relation_type, status: r.status, business: people.get(r.business_id)!, affiliate: people.get(r.affiliate_id)!, requestedBy: r.requested_by, createdAt: r.created_at }));
}

app.get("/suggestions", async (c) => {
  const a = auth(c);
  const { results } = await c.env.DB.prepare(
    `SELECT ${PROFILE_SUMMARY_COLS}, p.bio, p.visibility, COALESCE(s.growth_score, 0) AS gs, p.follower_count
     FROM profiles p LEFT JOIN profile_scores s ON s.profile_id = p.id
     WHERE p.id <> ?1 AND (p.kind <> 'ai' OR p.ai_class = 'persona') AND ${visibleAuthorSql("p")}
       AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ?1 AND f.followee_id = p.id)
     ORDER BY (COALESCE(s.growth_score, 0) + 0.15) * (0.25 + 1.5 * p.visibility / 100.0) * (0.6 + abs(random() % 1000) / 2500.0) DESC
     LIMIT 8`,
  )
    .bind(a.activeProfileId)
    .all<ProfileSummaryRow & { bio: string; visibility: number }>();
  return c.json({ items: results.map((r) => ({ ...toSummary(r), bio: r.bio })) });
});

app.get("/:handle", async (c) => {
  const a = auth(c);
  const p = await findProfile(c.env.DB, c.req.param("handle"));
  if (!p || p.status === "disabled") throw notFound("That profile doesn't exist.");
  const isSelf = p.id === a.activeProfileId;
  const rel = isSelf ? null : await relationship(c.env.DB, a.activeProfileId, p.id);
  if (rel?.blockedBy) throw notFound("That profile doesn't exist.");
  const [business, milestoneRows, affiliations, persona, viewer] = await Promise.all([
    p.kind === "business" ? c.env.DB.prepare("SELECT category, website FROM business_profiles WHERE profile_id = ?1").bind(p.id).first<{ category: string; website: string }>() : null,
    c.env.DB.prepare("SELECT level, achieved_at FROM milestones WHERE profile_id = ?1").bind(p.id).all<{ level: number; achieved_at: number }>(),
    affiliationsFor(c.env.DB, p.id),
    p.kind === "ai" ? c.env.DB.prepare("SELECT archetype, personality_json FROM ai_agents WHERE profile_id = ?1").bind(p.id).first<{ archetype: string; personality_json: string }>() : null,
    c.env.DB.prepare("SELECT kind, (SELECT allow_ai_dms FROM profiles WHERE id = ?2) AS t FROM profiles WHERE id = ?1").bind(a.activeProfileId, p.id).first<{ kind: string }>(),
  ]);
  const achieved = new Map(milestoneRows.results.map((m) => [m.level, m.achieved_at]));
  const canView = isSelf || !p.is_private || !!rel?.following;
  const detail: ProfileDetail = {
    ...toSummary(p),
    bio: p.bio,
    location: p.location,
    website: p.website,
    bannerUrl: p.banner_media_id && p.banner_ok ? `/api/media/${p.banner_media_id}` : null,
    appearance: parseAppearance(safeJson(p.appearance_json)),
    followerCount: p.follower_count,
    followingCount: p.following_count,
    postCount: p.post_count,
    createdAt: p.created_at,
    pinnedPostId: canView ? p.pinned_post_id : null,
    likesPublic: !!p.likes_public,
    interests: p.interests ? p.interests.split(",").filter(Boolean) : [],
    business: business ? { category: business.category, website: business.website } : null,
    affiliations,
    milestones: MILESTONES.map((m) => ({ level: m.level, threshold: m.threshold, name: m.name, material: m.material, achievedAt: achieved.get(m.level) ?? null })),
    relationship: rel
      ? { ...rel, canMessage: !rel.blocking && dmAllowed(p.dm_policy, rel.followedBy, p.kind, viewer?.kind ?? "personal", !!p.allow_ai_dms) }
      : null,
    isSelf,
    canView,
    aiPersona: persona ? { archetype: persona.archetype, summary: (safeJson(persona.personality_json) as { summary?: string }).summary ?? "" } : null,
  };
  return c.json(detail);
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Create an additional personal profile under the signed-in identity. */
app.post("/", async (c) => {
  const a = auth(c);
  const input = await body(c, z.object({ displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX), handle: z.string().trim().min(3).max(21), switchTo: z.boolean().default(true) }));
  await hit(c.env.DB, `profile-create:${a.identityId}`, 10, 24 * 3600_000, { message: "You've created a lot of profiles today. Try again tomorrow." });
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM profile_members WHERE identity_id = ?1 AND role = 'owner'").bind(a.identityId).first<{ n: number }>();
  if ((count?.n ?? 0) >= PROFILES_PER_IDENTITY) throw bad(`You can own up to ${PROFILES_PER_IDENTITY} profiles.`, "LIMIT");
  const { handle, display } = await assertHandleAvailable(c.env.DB, input.handle);
  const p = createProfileStatements(c.env.DB, { identityId: a.identityId, kind: "personal", handle, handleDisplay: display, displayName: input.displayName });
  await c.env.DB.batch(p.stmts);
  if (input.switchTo) await c.env.DB.prepare("UPDATE sessions SET active_profile_id = ?2 WHERE token_hash = ?1").bind(a.tokenHash, p.id).run();
  const next = input.switchTo ? { ...a, activeProfileId: p.id, profile: { id: p.id, kind: "personal" as const, handle, status: "active", role: "owner" as const } } : a;
  return c.json({ profileId: p.id, session: await sessionInfo(c.env, next) }, 201);
});

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
    bio: z.string().max(BIO_MAX_CHARS),
    location: z.string().trim().max(60),
    website: z.union([z.literal(""), z.string().trim().url().max(200).refine((u) => /^https?:\/\//i.test(u), "http(s) only")]),
    interests: z.array(z.enum(TOPIC_SLUGS as [string, ...string[]])).max(10),
    avatarMediaId: z.string().max(40).nullable(),
    bannerMediaId: z.string().max(40).nullable(),
    isPrivate: z.boolean(),
    likesPublic: z.boolean(),
    dmPolicy: z.enum(["everyone", "following", "none"]),
    allowAiReplies: z.boolean(),
    allowAiDms: z.boolean(),
    allowAiDiscovery: z.boolean(),
    notificationPrefs: z.record(z.enum(["follow", "follow_request", "like", "reply", "mention", "repost", "quote", "message", "milestone", "affiliate", "system"]), z.boolean()),
    onboarded: z.boolean(),
    pinnedPostId: z.string().max(40).nullable(),
  })
  .partial()
  .strict(); // rejects protected fields (visibility, counts, kind, roles…) instead of silently ignoring them

app.patch("/me", async (c) => {
  const a = actor(c);
  const input = await body(c, updateSchema);
  const db = c.env.DB;
  for (const [key, mediaId] of [["avatarMediaId", input.avatarMediaId], ["bannerMediaId", input.bannerMediaId]] as const) {
    if (!mediaId) continue;
    const m = await db.prepare("SELECT kind FROM media WHERE id = ?1 AND owner_id = ?2 AND purpose = 'profile' AND status = 'ready'").bind(mediaId, a.activeProfileId).first<{ kind: string }>();
    if (!m || m.kind !== "image") throw bad("Choose an image you uploaded for your profile.", "VALIDATION", { [key]: "Invalid image" });
  }
  if (input.pinnedPostId) {
    const ok = await db.prepare("SELECT 1 FROM posts WHERE id = ?1 AND author_id = ?2 AND deleted_at IS NULL").bind(input.pinnedPostId, a.activeProfileId).first();
    if (!ok) throw bad("You can only pin your own posts.");
  }
  const cols: Record<string, unknown> = {};
  if (input.displayName !== undefined) cols.display_name = input.displayName;
  if (input.bio !== undefined) cols.bio = input.bio;
  if (input.location !== undefined) cols.location = input.location;
  if (input.website !== undefined) cols.website = input.website;
  if (input.interests !== undefined) cols.interests = input.interests.join(",");
  if (input.avatarMediaId !== undefined) cols.avatar_media_id = input.avatarMediaId;
  if (input.bannerMediaId !== undefined) cols.banner_media_id = input.bannerMediaId;
  if (input.isPrivate !== undefined) cols.is_private = input.isPrivate ? 1 : 0;
  if (input.likesPublic !== undefined) cols.likes_public = input.likesPublic ? 1 : 0;
  if (input.dmPolicy !== undefined) cols.dm_policy = input.dmPolicy;
  if (input.allowAiReplies !== undefined) cols.allow_ai_replies = input.allowAiReplies ? 1 : 0;
  if (input.allowAiDms !== undefined) cols.allow_ai_dms = input.allowAiDms ? 1 : 0;
  if (input.allowAiDiscovery !== undefined) cols.allow_ai_discovery = input.allowAiDiscovery ? 1 : 0;
  if (input.notificationPrefs !== undefined) cols.notification_prefs = JSON.stringify(input.notificationPrefs);
  if (input.onboarded !== undefined) cols.onboarded = input.onboarded ? 1 : 0;
  if (input.pinnedPostId !== undefined) cols.pinned_post_id = input.pinnedPostId;
  const keys = Object.keys(cols);
  if (!keys.length) return c.json({ ok: true });
  // Column names come from the fixed whitelist above, never from input.
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
  await db.prepare(`UPDATE profiles SET ${sets}, updated_at = ?${keys.length + 2} WHERE id = ?1`).bind(a.activeProfileId, ...keys.map((k) => cols[k]), Date.now()).run();
  return c.json({ ok: true });
});

app.get("/me/settings", async (c) => {
  const a = auth(c);
  const p = await c.env.DB.prepare(
    "SELECT display_name, bio, location, website, interests, avatar_media_id, banner_media_id, is_private, likes_public, dm_policy, allow_ai_replies, allow_ai_dms, allow_ai_discovery, notification_prefs, onboarded, kind FROM profiles WHERE id = ?1",
  )
    .bind(a.activeProfileId)
    .first<Record<string, string | number | null>>();
  if (!p) throw notFound();
  return c.json({
    displayName: p.display_name,
    bio: p.bio,
    location: p.location,
    website: p.website,
    interests: String(p.interests || "").split(",").filter(Boolean),
    avatarMediaId: p.avatar_media_id,
    bannerMediaId: p.banner_media_id,
    isPrivate: !!p.is_private,
    likesPublic: !!p.likes_public,
    dmPolicy: p.dm_policy,
    allowAiReplies: !!p.allow_ai_replies,
    allowAiDms: !!p.allow_ai_dms,
    allowAiDiscovery: !!p.allow_ai_discovery,
    notificationPrefs: safeJson(String(p.notification_prefs || "{}")),
    onboarded: !!p.onboarded,
    kind: p.kind,
  });
});

app.put("/me/appearance", async (c) => {
  const a = actor(c);
  const raw = await c.req.json().catch(() => {
    throw bad("Request body must be JSON.");
  });
  const r = appearanceSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw bad(`Appearance ${issue?.path.join(".")}: ${issue?.message}`, "VALIDATION");
  }
  const appearance = parseAppearance(r.data);
  const db = c.env.DB;
  const mediaIds = [appearance.banner.mediaId, appearance.background.mediaId, ...appearance.highlightedMediaIds].filter((x): x is string => !!x);
  for (const id of new Set(mediaIds)) {
    const ok = await db.prepare("SELECT 1 FROM media WHERE id = ?1 AND owner_id = ?2 AND status = 'ready'").bind(id, a.activeProfileId).first();
    if (!ok) throw bad("Appearance references media you don't own or that has expired.");
  }
  for (const id of appearance.featuredPostIds) {
    const ok = await db.prepare("SELECT 1 FROM posts WHERE id = ?1 AND author_id = ?2 AND deleted_at IS NULL").bind(id, a.activeProfileId).first();
    if (!ok) throw bad("Featured posts must be your own posts.");
  }
  await db
    .prepare("UPDATE profiles SET appearance_json = ?2, appearance_version = ?3, theme_id = ?4, banner_media_id = COALESCE(?5, banner_media_id), updated_at = ?6 WHERE id = ?1")
    .bind(a.activeProfileId, JSON.stringify(appearance), appearance.v, appearance.themeId, appearance.banner.mediaId, Date.now())
    .run();
  return c.json({ appearance });
});

/** Deactivate a profile (content is kept but hidden). The last owned profile can't be deactivated. */
app.delete("/me", async (c) => {
  const a = actor(c);
  const owned = await c.env.DB.prepare(
    "SELECT p.id FROM profile_members m JOIN profiles p ON p.id = m.profile_id WHERE m.identity_id = ?1 AND m.role = 'owner' AND p.status <> 'disabled' AND p.kind = 'personal'",
  )
    .bind(a.identityId)
    .all<{ id: string }>();
  const others = owned.results.filter((r) => r.id !== a.activeProfileId);
  if (a.profile.role !== "owner") throw forbidden("Only the owner can deactivate this profile.");
  if (a.profile.kind === "personal" && others.length === 0) throw bad("You can't deactivate your only personal profile.");
  const fallback = others[0]?.id ?? owned.results[0]?.id;
  if (!fallback || fallback === a.activeProfileId) throw bad("Switch to another profile first.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE profiles SET status = 'disabled', updated_at = ?2 WHERE id = ?1").bind(a.activeProfileId, Date.now()),
    c.env.DB.prepare("UPDATE sessions SET active_profile_id = ?2 WHERE identity_id = ?1 AND active_profile_id = ?3").bind(a.identityId, fallback, a.activeProfileId),
  ]);
  return c.json({ ok: true, activeProfileId: fallback });
});

async function resolveViewable(c: { env: Env }, viewerId: string, handle: string) {
  const p = await c.env.DB.prepare("SELECT id, is_private, likes_public, status FROM profiles WHERE handle = ?1").bind(normalizeHandle(handle)).first<{ id: string; is_private: number; likes_public: number; status: string }>();
  if (!p || p.status === "disabled") throw notFound("That profile doesn't exist.");
  const rel = p.id === viewerId ? null : await relationship(c.env.DB, viewerId, p.id);
  if (rel?.blockedBy) throw notFound("That profile doesn't exist.");
  const canView = p.id === viewerId || !p.is_private || !!rel?.following;
  return { ...p, canView, isSelf: p.id === viewerId };
}

app.get("/:handle/timeline", async (c) => {
  const a = auth(c);
  const { tab, cursor } = query(c, z.object({ tab: z.enum(["posts", "replies", "media", "likes"]).default("posts"), cursor: z.string().max(200).optional() }));
  const p = await resolveViewable(c, a.activeProfileId, c.req.param("handle"));
  if (!p.canView) return c.json({ items: [], cursor: null, private: true });
  if (tab === "likes" && !p.likes_public && !p.isSelf) return c.json({ items: [], cursor: null, hidden: true });
  const cur = decodeCursor<[number, string]>(cursor);
  const limit = 20;
  const db = c.env.DB;
  let entries: { postId: string; repostedBy?: string | null; ts: number }[] = [];
  const curTs = cur?.[0] ?? Number.MAX_SAFE_INTEGER;
  const curId = cur?.[1] ?? "~";
  if (tab === "posts") {
    const { results } = await db
      .prepare(
        `SELECT post_id, by_id, ts FROM (
           SELECT id AS post_id, NULL AS by_id, created_at AS ts FROM posts WHERE author_id = ?1 AND reply_to_id IS NULL AND deleted_at IS NULL
           UNION ALL
           SELECT r.post_id, r.profile_id AS by_id, r.created_at AS ts FROM reposts r WHERE r.profile_id = ?1
         ) WHERE ts < ?2 OR (ts = ?2 AND post_id < ?3)
         ORDER BY ts DESC, post_id DESC LIMIT ?4`,
      )
      .bind(p.id, curTs, curId, limit)
      .all<{ post_id: string; by_id: string | null; ts: number }>();
    entries = results.map((r) => ({ postId: r.post_id, repostedBy: r.by_id, ts: r.ts }));
  } else if (tab === "replies") {
    const { results } = await db
      .prepare("SELECT id, created_at FROM posts WHERE author_id = ?1 AND reply_to_id IS NOT NULL AND deleted_at IS NULL AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC LIMIT ?4")
      .bind(p.id, curTs, curId, limit)
      .all<{ id: string; created_at: number }>();
    entries = results.map((r) => ({ postId: r.id, ts: r.created_at }));
  } else if (tab === "media") {
    const { results } = await db
      .prepare(
        `SELECT p.id, p.created_at FROM posts p WHERE p.author_id = ?1 AND p.deleted_at IS NULL AND EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id)
         AND (p.created_at < ?2 OR (p.created_at = ?2 AND p.id < ?3)) ORDER BY p.created_at DESC, p.id DESC LIMIT ?4`,
      )
      .bind(p.id, curTs, curId, limit)
      .all<{ id: string; created_at: number }>();
    entries = results.map((r) => ({ postId: r.id, ts: r.created_at }));
  } else {
    const { results } = await db
      .prepare("SELECT post_id, created_at FROM likes WHERE profile_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND post_id < ?3)) ORDER BY created_at DESC, post_id DESC LIMIT ?4")
      .bind(p.id, curTs, curId, limit)
      .all<{ post_id: string; created_at: number }>();
    entries = results.map((r) => ({ postId: r.post_id, ts: r.created_at }));
  }
  const items: FeedItem[] = await toFeedItems(db, a.activeProfileId, entries);
  const last = entries[entries.length - 1];
  return c.json({ items, cursor: entries.length === limit && last ? encodeCursor([last.ts, last.postId]) : null });
});

app.get("/:handle/:list{followers|following}", async (c) => {
  const a = auth(c);
  const list = c.req.param("list");
  const { cursor } = query(c, z.object({ cursor: z.string().max(200).optional() }));
  const p = await resolveViewable(c, a.activeProfileId, c.req.param("handle"));
  if (!p.canView) return c.json({ items: [], cursor: null, private: true });
  const cur = decodeCursor<[number, string]>(cursor);
  const limit = 30;
  const col = list === "followers" ? "follower_id" : "followee_id";
  const where = list === "followers" ? "followee_id" : "follower_id";
  const { results } = await c.env.DB
    .prepare(`SELECT ${col} AS pid, created_at FROM follows WHERE ${where} = ?1 AND (created_at < ?2 OR (created_at = ?2 AND ${col} < ?3)) ORDER BY created_at DESC, ${col} DESC LIMIT ?4`)
    .bind(p.id, cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~", limit)
    .all<{ pid: string; created_at: number }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.pid));
  const following = await c.env.DB
    .prepare(`SELECT followee_id FROM follows WHERE follower_id = ?1 AND followee_id IN (${results.map((_, i) => `?${i + 2}`).join(",") || "''"})`)
    .bind(a.activeProfileId, ...results.map((r) => r.pid))
    .all<{ followee_id: string }>();
  const fset = new Set(following.results.map((r) => r.followee_id));
  const items = results
    .map((r) => people.get(r.pid))
    .filter((x): x is ProfileSummary => !!x)
    .map((s) => ({ ...s, viewerFollows: fset.has(s.id) }));
  const last = results[results.length - 1];
  return c.json({ items, cursor: results.length === limit && last ? encodeCursor([last.created_at, last.pid]) : null });
});

export { visibilityMultiplier };
export default app;
