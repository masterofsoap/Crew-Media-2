import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AFFILIATION_TYPES, BIO_MAX_CHARS, BUSINESS_CATEGORIES, DISPLAY_NAME_MAX, PROFILES_PER_IDENTITY } from "../../shared/constants";
import { normalizeHandle } from "../../shared/text";
import { actor, auth } from "../lib/session";
import { bad, body, conflict, forbidden, notFound, query } from "../lib/http";
import { hit } from "../lib/ratelimit";
import { assertHandleAvailable, createProfileStatements, sessionInfo } from "../lib/profiles";
import { newId } from "../lib/ids";
import { notify } from "../lib/notify";
import { affiliationsFor } from "./profiles";
import { getSummaries, PROFILE_SUMMARY_COLS, toSummary, type ProfileSummaryRow } from "../lib/views";
import { likeEscape } from "./search";

const app = new Hono<AppEnv>();
const website = z.union([z.literal(""), z.string().trim().url().max(200).refine((u) => /^https?:\/\//i.test(u), "http(s) only")]);

app.post("/business", async (c) => {
  const a = auth(c);
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
      handle: z.string().trim().min(3).max(21),
      category: z.enum(BUSINESS_CATEGORIES),
      website: website.default(""),
      description: z.string().max(BIO_MAX_CHARS).default(""),
      switchTo: z.boolean().default(true),
    }),
  );
  await hit(c.env.DB, `profile-create:${a.identityId}`, 10, 24 * 3600_000);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM profile_members WHERE identity_id = ?1 AND role = 'owner'").bind(a.identityId).first<{ n: number }>();
  if ((count?.n ?? 0) >= PROFILES_PER_IDENTITY) throw bad(`You can own up to ${PROFILES_PER_IDENTITY} profiles.`, "LIMIT");
  const { handle, display } = await assertHandleAvailable(c.env.DB, input.handle);
  const p = createProfileStatements(c.env.DB, { identityId: a.identityId, kind: "business", handle, handleDisplay: display, displayName: input.name, bio: input.description, themeId: "minimal-architecture", dmPolicy: "everyone" });
  await c.env.DB.batch([
    ...p.stmts,
    c.env.DB.prepare("INSERT INTO business_profiles (profile_id, category, website, created_by) VALUES (?1, ?2, ?3, ?4)").bind(p.id, input.category, input.website, a.identityId),
    c.env.DB.prepare("UPDATE profiles SET website = ?2 WHERE id = ?1").bind(p.id, input.website),
  ]);
  if (input.switchTo) await c.env.DB.prepare("UPDATE sessions SET active_profile_id = ?2 WHERE token_hash = ?1").bind(a.tokenHash, p.id).run();
  const next = input.switchTo ? { ...a, activeProfileId: p.id, profile: { id: p.id, kind: "business" as const, handle, status: "active", role: "owner" as const } } : a;
  return c.json({ profileId: p.id, session: await sessionInfo(c.env, next) }, 201);
});

function requireBusiness(kind: string) {
  if (kind !== "business") throw forbidden("Switch to a business profile to use this.");
}

app.patch("/business", async (c) => {
  const a = actor(c);
  requireBusiness(a.profile.kind);
  const input = await body(c, z.object({ category: z.enum(BUSINESS_CATEGORIES).optional(), website: website.optional() }).strict());
  if (input.category) await c.env.DB.prepare("UPDATE business_profiles SET category = ?2 WHERE profile_id = ?1").bind(a.activeProfileId, input.category).run();
  if (input.website !== undefined) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE business_profiles SET website = ?2 WHERE profile_id = ?1").bind(a.activeProfileId, input.website),
      c.env.DB.prepare("UPDATE profiles SET website = ?2 WHERE id = ?1").bind(a.activeProfileId, input.website),
    ]);
  }
  return c.json({ ok: true });
});

/** Dashboard metrics are computed from real rows; nothing here is estimated or simulated. */
app.get("/business/dashboard", async (c) => {
  const a = auth(c);
  requireBusiness(a.profile.kind);
  const db = c.env.DB;
  const id = a.activeProfileId;
  const week = Date.now() - 7 * 24 * 3600_000;
  const [profile, biz, stats, top, recentFollowers] = await Promise.all([
    db.prepare("SELECT follower_count, following_count, post_count FROM profiles WHERE id = ?1").bind(id).first<{ follower_count: number; following_count: number; post_count: number }>(),
    db.prepare("SELECT category, website FROM business_profiles WHERE profile_id = ?1").bind(id).first<{ category: string; website: string }>(),
    db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM follows WHERE followee_id = ?1 AND created_at > ?2) AS new_followers,
          (SELECT COUNT(*) FROM posts WHERE author_id = ?1 AND created_at > ?2 AND deleted_at IS NULL) AS posts_7d,
          (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.author_id = ?1 AND l.created_at > ?2) AS likes_7d,
          (SELECT COUNT(*) FROM posts r JOIN posts p ON p.id = r.reply_to_id WHERE p.author_id = ?1 AND r.created_at > ?2 AND r.deleted_at IS NULL) AS replies_7d,
          (SELECT COUNT(*) FROM reposts x JOIN posts p ON p.id = x.post_id WHERE p.author_id = ?1 AND x.created_at > ?2) AS reposts_7d`,
      )
      .bind(id, week)
      .first<{ new_followers: number; posts_7d: number; likes_7d: number; replies_7d: number; reposts_7d: number }>(),
    db
      .prepare("SELECT id, text, like_count, reply_count, repost_count, created_at FROM posts WHERE author_id = ?1 AND deleted_at IS NULL ORDER BY (like_count + 2 * reply_count + 2 * repost_count) DESC, created_at DESC LIMIT 5")
      .bind(id)
      .all<{ id: string; text: string; like_count: number; reply_count: number; repost_count: number; created_at: number }>(),
    db.prepare("SELECT follower_id FROM follows WHERE followee_id = ?1 ORDER BY created_at DESC LIMIT 8").bind(id).all<{ follower_id: string }>(),
  ]);
  const people = await getSummaries(db, recentFollowers.results.map((r) => r.follower_id));
  return c.json({
    category: biz?.category ?? "",
    website: biz?.website ?? "",
    followers: profile?.follower_count ?? 0,
    following: profile?.following_count ?? 0,
    posts: profile?.post_count ?? 0,
    last7Days: { newFollowers: stats?.new_followers ?? 0, posts: stats?.posts_7d ?? 0, likes: stats?.likes_7d ?? 0, replies: stats?.replies_7d ?? 0, reposts: stats?.reposts_7d ?? 0 },
    topPosts: top.results.map((p) => ({ id: p.id, text: p.text, likes: p.like_count, replies: p.reply_count, reposts: p.repost_count, createdAt: p.created_at })),
    recentFollowers: recentFollowers.results.map((r) => people.get(r.follower_id)).filter(Boolean),
    affiliations: await affiliationsFor(db, id, true),
  });
});

app.get("/business/managers", async (c) => {
  const a = auth(c);
  requireBusiness(a.profile.kind);
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.identity_id, m.role, m.created_at,
        (SELECT p2.id FROM profile_members m2 JOIN profiles p2 ON p2.id = m2.profile_id WHERE m2.identity_id = m.identity_id AND m2.role = 'owner' AND p2.kind = 'personal' ORDER BY m2.created_at LIMIT 1) AS rep
       FROM profile_members m WHERE m.profile_id = ?1 ORDER BY m.role DESC, m.created_at`,
    )
    .bind(a.activeProfileId)
    .all<{ identity_id: string; role: string; created_at: number; rep: string | null }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.rep).filter((x): x is string => !!x));
  return c.json({
    items: results.map((r) => ({ identityId: r.identity_id, role: r.role, since: r.created_at, profile: r.rep ? (people.get(r.rep) ?? null) : null, isYou: r.identity_id === a.identityId })),
    canManage: a.profile.role === "owner",
  });
});

/** Add a manager by one of their personal profile handles. Managers can post/act as the business but can't manage managers. */
app.post("/business/managers", async (c) => {
  const a = actor(c);
  requireBusiness(a.profile.kind);
  if (a.profile.role !== "owner") throw forbidden("Only the business owner can add managers.");
  const { handle } = await body(c, z.object({ handle: z.string().trim().min(3).max(21) }));
  const target = await c.env.DB
    .prepare("SELECT p.id, m.identity_id FROM profiles p JOIN profile_members m ON m.profile_id = p.id AND m.role = 'owner' WHERE p.handle = ?1 AND p.kind = 'personal' AND p.status = 'active'")
    .bind(normalizeHandle(handle))
    .first<{ id: string; identity_id: string }>();
  if (!target) throw notFound("No personal profile with that handle.");
  if (target.identity_id === a.identityId) throw bad("You already own this business.");
  const r = await c.env.DB.prepare("INSERT OR IGNORE INTO profile_members (profile_id, identity_id, role, created_at) VALUES (?1, ?2, 'manager', ?3)").bind(a.activeProfileId, target.identity_id, Date.now()).run();
  if (!r.meta.changes) throw conflict("They already manage this business.");
  await notify(c.env, { recipientId: target.id, type: "system", actorId: a.activeProfileId, data: { message: "added you as a manager. Switch profiles to act as this business." } });
  return c.json({ ok: true }, 201);
});

app.delete("/business/managers/:identityId", async (c) => {
  const a = actor(c);
  requireBusiness(a.profile.kind);
  const target = c.req.param("identityId");
  if (a.profile.role !== "owner" && target !== a.identityId) throw forbidden("Only the owner can remove other managers.");
  const r = await c.env.DB.prepare("DELETE FROM profile_members WHERE profile_id = ?1 AND identity_id = ?2 AND role = 'manager'").bind(a.activeProfileId, target).run();
  if (!r.meta.changes) throw notFound("Manager not found.");
  await c.env.DB.prepare("UPDATE sessions SET active_profile_id = (SELECT profile_id FROM profile_members WHERE identity_id = ?1 AND role = 'owner' ORDER BY created_at LIMIT 1) WHERE identity_id = ?1 AND active_profile_id = ?2").bind(target, a.activeProfileId).run();
  return c.json({ ok: true });
});

// ───────────── Affiliations ─────────────

app.get("/affiliations", async (c) => {
  const a = auth(c);
  return c.json({ items: await affiliationsFor(c.env.DB, a.activeProfileId, true), actingId: a.activeProfileId });
});

app.get("/affiliations/eligible", async (c) => {
  const a = auth(c);
  const { q } = query(c, z.object({ q: z.string().trim().min(1).max(40) }));
  const { results } = await c.env.DB
    .prepare(
      `SELECT ${PROFILE_SUMMARY_COLS} FROM profiles p
       WHERE p.kind IN ('personal','business') AND p.status = 'active' AND p.id <> ?1
         AND (p.handle LIKE ?2 ESCAPE '!' OR p.display_name LIKE ?2 ESCAPE '!')
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = p.id AND b.blocked_id = ?1) OR (b.blocker_id = ?1 AND b.blocked_id = p.id))
       ORDER BY p.follower_count DESC LIMIT 10`,
    )
    .bind(a.activeProfileId, `%${likeEscape(q)}%`)
    .all<ProfileSummaryRow>();
  return c.json({ items: results.map(toSummary) });
});

/**
 * A business proposes an affiliation; the other profile must accept before it is displayed.
 * Nobody can be listed as an affiliate without their consent.
 */
app.post("/affiliations", async (c) => {
  const a = actor(c);
  requireBusiness(a.profile.kind);
  const input = await body(c, z.object({ targetId: z.string().max(40), relationType: z.enum(AFFILIATION_TYPES.map((t) => t.value) as [string, ...string[]]) }));
  if (input.targetId === a.activeProfileId) throw bad("A business can't affiliate with itself.");
  await hit(c.env.DB, `affil:${a.activeProfileId}`, 30, 24 * 3600_000);
  const t = await c.env.DB.prepare("SELECT id, kind, status FROM profiles WHERE id = ?1").bind(input.targetId).first<{ id: string; kind: string; status: string }>();
  if (!t || t.status !== "active" || t.kind === "ai") throw notFound("That profile can't be an affiliate.");
  const existing = await c.env.DB.prepare("SELECT id, status FROM affiliations WHERE business_id = ?1 AND affiliate_id = ?2").bind(a.activeProfileId, t.id).first<{ id: string; status: string }>();
  const now = Date.now();
  if (existing && (existing.status === "pending" || existing.status === "accepted")) throw conflict("An affiliation already exists or is pending.");
  if (existing) {
    await c.env.DB.prepare("UPDATE affiliations SET status = 'pending', relation_type = ?2, requested_by = ?3, created_at = ?4, responded_at = NULL WHERE id = ?1").bind(existing.id, input.relationType, a.activeProfileId, now).run();
  } else {
    await c.env.DB.prepare("INSERT INTO affiliations (id, business_id, affiliate_id, relation_type, status, requested_by, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?2, ?5)").bind(newId(now), a.activeProfileId, t.id, input.relationType, now).run();
  }
  await notify(c.env, { recipientId: t.id, type: "affiliate", actorId: a.activeProfileId, data: { relationType: input.relationType, state: "requested" } });
  return c.json({ ok: true }, 201);
});

app.post("/affiliations/:id/respond", async (c) => {
  const a = actor(c);
  const { accept } = await body(c, z.object({ accept: z.boolean() }));
  const af = await c.env.DB.prepare("SELECT id, business_id, affiliate_id, status, requested_by FROM affiliations WHERE id = ?1").bind(c.req.param("id")).first<{ id: string; business_id: string; affiliate_id: string; status: string; requested_by: string }>();
  if (!af || af.status !== "pending") throw notFound("That request no longer exists.");
  const responder = af.requested_by === af.business_id ? af.affiliate_id : af.business_id;
  if (responder !== a.activeProfileId) throw forbidden("Only the invited profile can respond.");
  await c.env.DB.prepare("UPDATE affiliations SET status = ?2, responded_at = ?3 WHERE id = ?1").bind(af.id, accept ? "accepted" : "declined", Date.now()).run();
  await notify(c.env, { recipientId: af.requested_by, type: "affiliate", actorId: a.activeProfileId, data: { state: accept ? "accepted" : "declined" } });
  return c.json({ ok: true });
});

app.delete("/affiliations/:id", async (c) => {
  const a = actor(c);
  const af = await c.env.DB.prepare("SELECT id, business_id, affiliate_id FROM affiliations WHERE id = ?1").bind(c.req.param("id")).first<{ id: string; business_id: string; affiliate_id: string }>();
  if (!af || (af.business_id !== a.activeProfileId && af.affiliate_id !== a.activeProfileId)) throw notFound();
  await c.env.DB.prepare("UPDATE affiliations SET status = 'removed', responded_at = ?2 WHERE id = ?1").bind(af.id, Date.now()).run();
  return c.json({ ok: true });
});

export default app;
