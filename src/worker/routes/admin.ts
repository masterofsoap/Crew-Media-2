import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Auth } from "../env";
import { normalizeHandle } from "../../shared/text";
import { auth } from "../lib/session";
import { bad, body, conflict, decodeCursor, encodeCursor, forbidden, notFound, query, unauthorized, HttpError } from "../lib/http";
import { hashSecret, sha256Hex, timingSafeEqual, verifySecret } from "../lib/crypto";
import { hit } from "../lib/ratelimit";
import { configSchema, getConfig, saveConfig, getFlag, setFlag } from "../lib/settings";
import { newId, humanCode, dayKey } from "../lib/ids";
import { verifyAccessJwt } from "../lib/access";
import { requirePin } from "./auth";
import { PROFILE_SUMMARY_COLS, toSummary, getSummaries, hydratePosts, type ProfileSummaryRow } from "../lib/views";
import { deletePost } from "./posts";
import { enqueue } from "../jobs/queue";
import { runMaintenance, type MaintenanceTask } from "../jobs/cron";
import { likeEscape } from "./search";

const app = new Hono<AppEnv>();
const ELEVATION_MS = 15 * 60_000;
type Role = "owner" | "admin" | "moderator";
const RANK: Record<Role, number> = { moderator: 1, admin: 2, owner: 3 };

/**
 * Admin access is enforced here on every request (never by hiding UI):
 *  1. optional Cloudflare Access JWT (if configured),
 *  2. a valid session whose identity holds an admin role,
 *  3. for mutations, a recent step-up with the separate admin passphrase (not the PIN).
 */
app.use("*", async (c, next) => {
  if (c.req.path.endsWith("/bootstrap")) return next();
  if (!(await verifyAccessJwt(c.env, c.req.header("Cf-Access-Jwt-Assertion")))) throw forbidden("Administrative access requires Cloudflare Access.");
  const a = auth(c);
  if (!a.adminRole) throw new HttpError(404, "NOT_FOUND", "Not found.");
  await next();
});

function need(c: Context<AppEnv>, min: Role, elevated = true): Auth {
  const a = auth(c);
  if (!a.adminRole || RANK[a.adminRole] < RANK[min]) throw forbidden("Your admin role doesn't allow this.");
  if (elevated && a.elevatedUntil < Date.now()) throw new HttpError(403, "ELEVATION_REQUIRED", "Confirm your admin passphrase to continue.");
  return a;
}

async function audit(env: Env, a: Auth, action: string, targetType: string | null, targetId: string | null, before: unknown, after: unknown) {
  await env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_identity_id, actor_profile_id, action, target_type, target_id, before_json, after_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(newId(), a.identityId, a.activeProfileId, action, targetType, targetId, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), Date.now())
    .run();
}

const passphrase = z.string().min(12, "Use at least 12 characters").max(200);

/**
 * One-time owner bootstrap. Requires the BOOTSTRAP_OWNER_TOKEN deployment secret and only works
 * while no owner exists. The first registrant is never made an admin automatically.
 */
app.post("/bootstrap", async (c) => {
  const a = auth(c);
  const input = await body(c, z.object({ token: z.string().min(8).max(200), passphrase, pin: z.string().max(12) }));
  await hit(c.env.DB, `bootstrap:${a.identityId}`, 5, 3600_000);
  if (!c.env.BOOTSTRAP_OWNER_TOKEN || !timingSafeEqual(input.token, c.env.BOOTSTRAP_OWNER_TOKEN)) throw forbidden("Invalid bootstrap token.");
  await requirePin(c.env, a.identityId, input.pin);
  const owner = await c.env.DB.prepare("SELECT 1 FROM admin_roles WHERE role = 'owner'").first();
  if (owner) throw conflict("An owner already exists. Ask them to grant you access.");
  const h = await hashSecret(input.passphrase, c.env.PIN_PEPPER);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO admin_roles (identity_id, role, granted_by, granted_at) VALUES (?1, 'owner', NULL, ?2)").bind(a.identityId, now),
    c.env.DB.prepare("UPDATE identities SET admin_secret_hash = ?2, admin_secret_salt = ?3 WHERE id = ?1").bind(a.identityId, h.hash, h.salt),
    c.env.DB.prepare("UPDATE sessions SET elevated_until = ?2 WHERE token_hash = ?1").bind(a.tokenHash, now + ELEVATION_MS),
  ]);
  await audit(c.env, { ...a, adminRole: "owner" }, "bootstrap_owner", "identity", a.identityId, null, { role: "owner" });
  return c.json({ ok: true });
});

/** Set the admin passphrase (first time after being granted a role). Requires the PIN. */
app.post("/passphrase", async (c) => {
  const a = need(c, "moderator", false);
  const input = await body(c, z.object({ pin: z.string().max(12), passphrase }));
  const existing = await c.env.DB.prepare("SELECT admin_secret_hash FROM identities WHERE id = ?1").bind(a.identityId).first<{ admin_secret_hash: string | null }>();
  if (existing?.admin_secret_hash && a.elevatedUntil < Date.now()) throw new HttpError(403, "ELEVATION_REQUIRED", "Confirm your current passphrase first.");
  await requirePin(c.env, a.identityId, input.pin);
  const h = await hashSecret(input.passphrase, c.env.PIN_PEPPER);
  await c.env.DB.prepare("UPDATE identities SET admin_secret_hash = ?2, admin_secret_salt = ?3 WHERE id = ?1").bind(a.identityId, h.hash, h.salt).run();
  await audit(c.env, a, "set_admin_passphrase", "identity", a.identityId, null, null);
  return c.json({ ok: true });
});

app.post("/elevate", async (c) => {
  const a = need(c, "moderator", false);
  const { passphrase: pass } = await body(c, z.object({ passphrase: z.string().max(200) }));
  await hit(c.env.DB, `elevate:${a.identityId}`, 6, 15 * 60_000, { message: "Too many attempts. Try again later." });
  const i = await c.env.DB.prepare("SELECT admin_secret_hash, admin_secret_salt FROM identities WHERE id = ?1").bind(a.identityId).first<{ admin_secret_hash: string | null; admin_secret_salt: string | null }>();
  if (!i?.admin_secret_hash || !i.admin_secret_salt) throw bad("Set an admin passphrase first.", "NO_PASSPHRASE");
  if (!(await verifySecret(pass, c.env.PIN_PEPPER, i.admin_secret_hash, i.admin_secret_salt, 100_000))) throw unauthorized("That passphrase is incorrect.");
  const until = Date.now() + ELEVATION_MS;
  await c.env.DB.prepare("UPDATE sessions SET elevated_until = ?2 WHERE token_hash = ?1").bind(a.tokenHash, until).run();
  return c.json({ elevatedUntil: until });
});

// ───────────── Dashboard ─────────────

app.get("/dashboard", async (c) => {
  need(c, "moderator", false);
  const db = c.env.DB;
  const now = Date.now();
  const day = now - 24 * 3600_000;
  const [counts, regs, posts, jobs, usage, mediaStats, reports, auditRows, errors, cfg] = await Promise.all([
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM identities) AS identities,
                (SELECT COUNT(*) FROM profiles WHERE kind = 'personal') AS personal,
                (SELECT COUNT(*) FROM profiles WHERE kind = 'business') AS business,
                (SELECT COUNT(*) FROM profiles WHERE kind = 'ai' AND ai_class = 'persona') AS ai_personas,
                (SELECT COALESCE(MAX(audience_slot), -1) + 1 FROM profiles WHERE audience_slot IS NOT NULL) AS ai_audience,
                (SELECT COUNT(*) FROM ai_agents a JOIN profiles p ON p.id = a.profile_id WHERE a.enabled = 1 AND p.ai_class = 'persona') AS ai_enabled,
                (SELECT COUNT(*) FROM ai_agents WHERE last_active_at > ?1) AS ai_active_24h,
                (SELECT COUNT(*) FROM posts WHERE created_at > ?1) AS posts_24h,
                (SELECT COUNT(*) FROM posts WHERE created_at > ?1 AND ai_generated = 1) AS ai_posts_24h,
                (SELECT COUNT(*) FROM messages WHERE created_at > ?1) AS messages_24h`,
      )
      .bind(day)
      .first<Record<string, number>>(),
    db.prepare(`SELECT ${PROFILE_SUMMARY_COLS}, p.created_at FROM profiles p WHERE p.kind <> 'ai' ORDER BY p.created_at DESC LIMIT 8`).all<ProfileSummaryRow & { created_at: number }>(),
    db.prepare("SELECT id FROM posts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 6").all<{ id: string }>(),
    db.prepare("SELECT queue, status, COUNT(*) AS n FROM jobs WHERE updated_at > ?1 GROUP BY queue, status").bind(day).all<{ queue: string; status: string; n: number }>(),
    db.prepare("SELECT model, task, calls, errors, input_tokens, output_tokens FROM ai_usage WHERE day = ?1").bind(dayKey()).all<{ model: string; task: string; calls: number; errors: number; input_tokens: number; output_tokens: number }>(),
    db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM media WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at > ?1) AS active_expiring,
          (SELECT COUNT(*) FROM media WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?1) AS overdue,
          (SELECT COUNT(*) FROM media WHERE status IN ('expiring','deleting')) AS in_cleanup,
          (SELECT COUNT(*) FROM media WHERE status = 'expired') AS expired,
          (SELECT COUNT(*) FROM media WHERE status = 'failed') AS failed,
          (SELECT COALESCE(SUM(size_bytes), 0) FROM media WHERE status = 'ready') AS bytes_ready`,
      )
      .bind(now)
      .first<Record<string, number>>(),
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").first<{ n: number }>(),
    db.prepare("SELECT id, actor_identity_id, action, target_type, target_id, created_at FROM admin_audit ORDER BY created_at DESC LIMIT 10").all(),
    db.prepare("SELECT COUNT(*) AS n FROM ops_log WHERE level = 'error' AND created_at > ?1").bind(day).first<{ n: number }>(),
    getConfig(db),
  ]);
  const recentPosts = await hydratePosts(db, auth(c).activeProfileId, posts.results.map((p) => p.id));
  return c.json({
    counts,
    recentRegistrations: regs.results.map((r) => ({ ...toSummary(r), createdAt: r.created_at })),
    recentPosts: posts.results.map((p) => recentPosts.get(p.id)).filter(Boolean),
    jobs: jobs.results,
    aiUsageToday: usage.results,
    aiBudget: { dailyCallBudget: cfg.ai.dailyCallBudget, dailyTokenBudget: cfg.ai.dailyTokenBudget, paused: cfg.ai.paused },
    media: mediaStats,
    openReports: reports?.n ?? 0,
    errors24h: errors?.n ?? 0,
    audit: auditRows.results,
    storageNote: "Bytes reflect media tracked in D1 with status 'ready'. R2 bucket-level usage is available in the Cloudflare dashboard.",
  });
});

// ───────────── Accounts ─────────────

app.get("/accounts", async (c) => {
  need(c, "moderator", false);
  const { q, kind, cursor } = query(c, z.object({ q: z.string().trim().max(60).default(""), kind: z.enum(["all", "personal", "business", "ai", "audience"]).default("all"), cursor: z.string().max(100).optional() }));
  const off = decodeCursor<{ off: number }>(cursor)?.off ?? 0;
  const limit = 30;
  const { results } = await c.env.DB
    .prepare(
      `SELECT ${PROFILE_SUMMARY_COLS}, p.status, p.visibility, p.follower_count, p.created_at FROM profiles p
       WHERE (?1 = '' OR p.handle LIKE ?2 ESCAPE '!' OR p.display_name LIKE ?2 ESCAPE '!') AND ((?3 = 'audience' AND p.ai_class = 'audience') OR (?3 <> 'audience' AND p.ai_class IS NOT 'audience' AND (?3 = 'all' OR p.kind = ?3)))
       ORDER BY p.created_at DESC LIMIT ?4 OFFSET ?5`,
    )
    .bind(q, `%${likeEscape(q)}%`, kind, limit, off)
    .all<ProfileSummaryRow & { status: string; visibility: number; follower_count: number; created_at: number }>();
  return c.json({
    items: results.map((r) => ({ ...toSummary(r), status: r.status, visibility: r.visibility, followerCount: r.follower_count, createdAt: r.created_at })),
    cursor: results.length === limit ? encodeCursor({ off: off + limit }) : null,
  });
});

app.get("/accounts/:id", async (c) => {
  need(c, "moderator", false);
  const db = c.env.DB;
  const id = c.req.param("id");
  const p = await db
    .prepare(`SELECT ${PROFILE_SUMMARY_COLS}, p.status, p.visibility, p.follower_count, p.following_count, p.post_count, p.created_at, p.bio, p.allow_ai_replies, p.allow_ai_dms, p.allow_ai_discovery FROM profiles p WHERE p.id = ?1`)
    .bind(id)
    .first<ProfileSummaryRow & Record<string, string | number | null>>();
  if (!p) throw notFound();
  const owner = await db
    .prepare(
      `SELECT i.id, i.status, i.created_at, i.last_login_at, i.failed_attempts, i.locked_until, (SELECT role FROM admin_roles WHERE identity_id = i.id) AS admin_role
       FROM profile_members m JOIN identities i ON i.id = m.identity_id WHERE m.profile_id = ?1 AND m.role = 'owner'`,
    )
    .bind(id)
    .first<{ id: string; status: string; created_at: number; last_login_at: number | null; failed_attempts: number; locked_until: number; admin_role: string | null }>();
  const siblings = owner ? (await db.prepare("SELECT profile_id FROM profile_members WHERE identity_id = ?1").bind(owner.id).all<{ profile_id: string }>()).results.map((r) => r.profile_id) : [];
  const [people, scores, reports, recent, agent, milestones] = await Promise.all([
    getSummaries(db, siblings),
    db.prepare("SELECT quality, consistency, engagement, retention, spam_penalty, growth_score, updated_at FROM profile_scores WHERE profile_id = ?1").bind(id).first(),
    db.prepare("SELECT id, reason, status, created_at FROM reports WHERE target_type = 'profile' AND target_id = ?1 ORDER BY created_at DESC LIMIT 20").bind(id).all(),
    db.prepare("SELECT id, text, created_at, deleted_at, moderation_status, ai_generated FROM posts WHERE author_id = ?1 ORDER BY created_at DESC LIMIT 10").bind(id).all(),
    db.prepare("SELECT archetype, activity_level, enabled, state, last_active_at, actions_today, generations_today FROM ai_agents WHERE profile_id = ?1").bind(id).first(),
    db.prepare("SELECT level, achieved_at FROM milestones WHERE profile_id = ?1 ORDER BY level").bind(id).all(),
  ]);
  return c.json({
    profile: { ...toSummary(p), status: p.status, visibility: p.visibility, followerCount: p.follower_count, followingCount: p.following_count, postCount: p.post_count, createdAt: p.created_at, bio: p.bio, aiPrefs: { replies: !!p.allow_ai_replies, dms: !!p.allow_ai_dms, discovery: !!p.allow_ai_discovery } },
    identity: owner ? { id: owner.id, status: owner.status, createdAt: owner.created_at, lastLoginAt: owner.last_login_at, failedAttempts: owner.failed_attempts, lockedUntil: owner.locked_until, adminRole: owner.admin_role } : null,
    profiles: siblings.map((s) => people.get(s)).filter(Boolean),
    scores,
    reports: reports.results,
    recentPosts: recent.results,
    agent,
    milestones: milestones.results,
  });
});

/** Visibility slider (0–100). Discovery weighting only — never overrides privacy, blocks or moderation. */
app.patch("/accounts/:id/visibility", async (c) => {
  const a = need(c, "admin");
  const { value } = await body(c, z.object({ value: z.number().int().min(0).max(100) }));
  const before = await c.env.DB.prepare("SELECT visibility FROM profiles WHERE id = ?1").bind(c.req.param("id")).first<{ visibility: number }>();
  if (!before) throw notFound();
  await c.env.DB.prepare("UPDATE profiles SET visibility = ?2 WHERE id = ?1").bind(c.req.param("id"), value).run();
  await audit(c.env, a, "set_visibility", "profile", c.req.param("id"), before, { visibility: value });
  return c.json({ visibility: value });
});

app.post("/accounts/:id/status", async (c) => {
  const a = need(c, "moderator");
  const { status, reason } = await body(c, z.object({ status: z.enum(["active", "suspended"]), reason: z.string().max(300).default("") }));
  const before = await c.env.DB.prepare("SELECT status FROM profiles WHERE id = ?1").bind(c.req.param("id")).first<{ status: string }>();
  if (!before) throw notFound();
  await c.env.DB.prepare("UPDATE profiles SET status = ?2 WHERE id = ?1").bind(c.req.param("id"), status).run();
  await audit(c.env, a, "set_profile_status", "profile", c.req.param("id"), before, { status, reason });
  return c.json({ status });
});

app.post("/identities/:id/status", async (c) => {
  const a = need(c, "admin");
  const { status } = await body(c, z.object({ status: z.enum(["active", "suspended"]) }));
  const target = c.req.param("id");
  if (target === a.identityId) throw bad("You can't change your own account status.");
  const role = await c.env.DB.prepare("SELECT role FROM admin_roles WHERE identity_id = ?1").bind(target).first<{ role: Role }>();
  if (role?.role === "owner") throw forbidden("Owners can't be suspended.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE identities SET status = ?2 WHERE id = ?1").bind(target, status),
    ...(status === "suspended" ? [c.env.DB.prepare("DELETE FROM sessions WHERE identity_id = ?1").bind(target)] : []),
  ]);
  await audit(c.env, a, "set_identity_status", "identity", target, null, { status });
  return c.json({ status });
});

/** Issue a one-time PIN reset code (24h) for assisted recovery. Shown once; only its hash is stored. */
app.post("/identities/:id/recovery-token", async (c) => {
  const a = need(c, "admin");
  const target = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT 1 FROM identities WHERE id = ?1").bind(target).first();
  if (!exists) throw notFound();
  const code = humanCode(4, 5);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO recovery_tokens (id, identity_id, token_hash, issued_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(newId(now), target, await sha256Hex(`reset:${code}`), a.identityId, now, now + 24 * 3600_000)
    .run();
  await audit(c.env, a, "issue_recovery_token", "identity", target, null, { expiresAt: now + 24 * 3600_000 });
  return c.json({ code, expiresAt: now + 24 * 3600_000 });
});

// ───────────── Administrators ─────────────

app.get("/admins", async (c) => {
  need(c, "moderator", false);
  const { results } = await c.env.DB
    .prepare(
      `SELECT r.identity_id, r.role, r.granted_by, r.granted_at,
        (SELECT m.profile_id FROM profile_members m JOIN profiles p ON p.id = m.profile_id WHERE m.identity_id = r.identity_id AND m.role = 'owner' AND p.kind = 'personal' ORDER BY m.created_at LIMIT 1) AS rep
       FROM admin_roles r ORDER BY r.granted_at`,
    )
    .all<{ identity_id: string; role: Role; granted_by: string | null; granted_at: number; rep: string | null }>();
  const people = await getSummaries(c.env.DB, results.map((r) => r.rep).filter((x): x is string => !!x));
  return c.json({ items: results.map((r) => ({ identityId: r.identity_id, role: r.role, grantedBy: r.granted_by, grantedAt: r.granted_at, profile: r.rep ? (people.get(r.rep) ?? null) : null })) });
});

app.post("/admins", async (c) => {
  const a = need(c, "admin");
  const { handle, role } = await body(c, z.object({ handle: z.string().trim().min(3).max(21), role: z.enum(["owner", "admin", "moderator"]) }));
  if (RANK[role] >= RANK[a.adminRole!] && a.adminRole !== "owner") throw forbidden("You can only grant roles below your own.");
  const target = await c.env.DB
    .prepare("SELECT m.identity_id FROM profiles p JOIN profile_members m ON m.profile_id = p.id AND m.role = 'owner' WHERE p.handle = ?1 AND p.kind <> 'ai'")
    .bind(normalizeHandle(handle))
    .first<{ identity_id: string }>();
  if (!target) throw notFound("No account with that handle.");
  const before = await c.env.DB.prepare("SELECT role FROM admin_roles WHERE identity_id = ?1").bind(target.identity_id).first<{ role: Role }>();
  if (before && RANK[before.role] >= RANK[a.adminRole!] && a.adminRole !== "owner") throw forbidden("You can't change that administrator's role.");
  await c.env.DB.prepare("INSERT INTO admin_roles (identity_id, role, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(identity_id) DO UPDATE SET role = ?2, granted_by = ?3, granted_at = ?4")
    .bind(target.identity_id, role, a.identityId, Date.now())
    .run();
  await audit(c.env, a, "grant_admin", "identity", target.identity_id, before ?? null, { role });
  return c.json({ ok: true });
});

app.delete("/admins/:identityId", async (c) => {
  const a = need(c, "admin");
  const target = c.req.param("identityId");
  const before = await c.env.DB.prepare("SELECT role FROM admin_roles WHERE identity_id = ?1").bind(target).first<{ role: Role }>();
  if (!before) throw notFound();
  if (RANK[before.role] >= RANK[a.adminRole!] && a.adminRole !== "owner") throw forbidden("You can't revoke that administrator.");
  if (before.role === "owner") {
    const owners = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_roles WHERE role = 'owner'").first<{ n: number }>();
    if ((owners?.n ?? 0) <= 1) throw bad("You can't remove the last owner.");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM admin_roles WHERE identity_id = ?1").bind(target),
    c.env.DB.prepare("UPDATE sessions SET elevated_until = 0 WHERE identity_id = ?1").bind(target),
  ]);
  await audit(c.env, a, "revoke_admin", "identity", target, before, null);
  return c.json({ ok: true });
});

// ───────────── Settings & AI ─────────────

app.get("/settings", async (c) => {
  need(c, "moderator", false);
  return c.json({ config: await getConfig(c.env.DB, true), seeded: !!(await getFlag(c.env.DB, "ai_seeded")) });
});

app.put("/settings", async (c) => {
  const a = need(c, "admin");
  const next = configSchema.parse(await c.req.json().catch(() => ({})));
  const before = await getConfig(c.env.DB, true);
  await saveConfig(c.env.DB, next, a.identityId);
  await audit(c.env, a, "update_settings", "settings", "config", before, next);
  return c.json({ config: next });
});

app.post("/ai/:action{pause|resume}", async (c) => {
  const a = need(c, "admin");
  const cfg = await getConfig(c.env.DB, true);
  const paused = c.req.param("action") === "pause";
  await saveConfig(c.env.DB, { ...cfg, ai: { ...cfg.ai, paused } }, a.identityId);
  await audit(c.env, a, paused ? "ai_pause" : "ai_resume", "settings", "ai", { paused: cfg.ai.paused }, { paused });
  return c.json({ paused });
});

app.get("/ai/overview", async (c) => {
  need(c, "moderator", false);
  const db = c.env.DB;
  const { results: agents } = await db
    .prepare(
      `SELECT a.profile_id, a.archetype, a.activity_level, a.enabled, a.state, a.last_active_at, a.next_wake_at, a.actions_today, a.generations_today, p.follower_count
       FROM ai_agents a JOIN profiles p ON p.id = a.profile_id WHERE p.ai_class = 'persona' ORDER BY a.last_active_at DESC NULLS LAST LIMIT 300`,
    )
    .all<{ profile_id: string; archetype: string; activity_level: string; enabled: number; state: string; last_active_at: number | null; next_wake_at: number; actions_today: number; generations_today: number; follower_count: number }>();
  const people = await getSummaries(db, agents.map((x) => x.profile_id));
  const [usage, jobs, errors, recentJobs] = await Promise.all([
    db.prepare("SELECT day, model, task, calls, errors, input_tokens, output_tokens FROM ai_usage WHERE day >= ?1 ORDER BY day DESC").bind(dayKey(Date.now() - 6 * 24 * 3600_000)).all(),
    db.prepare("SELECT kind, status, COUNT(*) AS n FROM jobs WHERE queue = 'ai' AND updated_at > ?1 GROUP BY kind, status").bind(Date.now() - 24 * 3600_000).all(),
    db.prepare("SELECT id, level, source, message, data_json, created_at FROM ops_log WHERE source LIKE 'ai%' ORDER BY created_at DESC LIMIT 30").all(),
    db.prepare("SELECT kind, dedupe_key, status, attempts, last_error, updated_at FROM jobs WHERE queue = 'ai' AND status IN ('failed','dead') ORDER BY updated_at DESC LIMIT 20").all(),
  ]);
  return c.json({
    agents: agents.map((x) => ({ profile: people.get(x.profile_id), archetype: x.archetype, activity: x.activity_level, enabled: !!x.enabled, state: x.state, lastActiveAt: x.last_active_at, nextWakeAt: x.next_wake_at, actionsToday: x.actions_today, generationsToday: x.generations_today, followers: x.follower_count })),
    usage: usage.results,
    jobs: jobs.results,
    errors: errors.results,
    failedJobs: recentJobs.results,
    config: (await getConfig(db, true)).ai,
    seeded: !!(await getFlag(db, "ai_seeded")),
  });
});

app.patch("/ai/agents/:id", async (c) => {
  const a = need(c, "moderator");
  const { enabled } = await body(c, z.object({ enabled: z.boolean() }));
  const r = await c.env.DB.prepare("UPDATE ai_agents SET enabled = ?2, state = CASE WHEN ?2 = 1 THEN 'idle' ELSE 'disabled' END WHERE profile_id = ?1").bind(c.req.param("id"), enabled ? 1 : 0).run();
  if (!r.meta.changes) throw notFound();
  await audit(c.env, a, enabled ? "ai_agent_enable" : "ai_agent_disable", "profile", c.req.param("id"), null, { enabled });
  return c.json({ enabled });
});

app.post("/ai/seed", async (c) => {
  const a = need(c, "admin");
  await setFlag(c.env.DB, "ai_seed_requested", Date.now(), a.identityId);
  const sent = await enqueue(c.env, "ai", { kind: "population.seed", key: `seed:${dayKey()}:${Date.now()}` });
  await audit(c.env, a, "ai_seed", "settings", "ai", null, { sent });
  return c.json({ queued: sent });
});

app.post("/ai/audience", async (c) => {
  const a = need(c, "admin");
  const { count } = await body(c, z.object({ count: z.number().int().min(1).max(1_100_000) }));
  const sent = await enqueue(c.env, "ai", { kind: "population.expand", count, key: `expand:${Date.now()}` });
  await audit(c.env, a, "ai_audience_expand", "settings", "ai", null, { count });
  return c.json({ queued: sent });
});

app.post("/maintenance/:task", async (c) => {
  const a = need(c, "admin");
  const task = z.enum(["media-cleanup", "reconcile", "trends", "growth", "ai-tick", "prune"]).parse(c.req.param("task")) as MaintenanceTask;
  const result = await runMaintenance(c.env, task);
  await audit(c.env, a, "maintenance", "task", task, null, result);
  return c.json({ task, result });
});

// ───────────── Media ─────────────

app.get("/media", async (c) => {
  need(c, "moderator", false);
  const db = c.env.DB;
  const now = Date.now();
  const [upcoming, failed, recentExpired, byStatus] = await Promise.all([
    db.prepare("SELECT id, owner_id, kind, size_bytes, created_at, expires_at FROM media WHERE status = 'ready' AND expires_at IS NOT NULL ORDER BY expires_at LIMIT 20").all(),
    db.prepare("SELECT id, owner_id, kind, status, delete_attempts, last_error, expires_at FROM media WHERE status = 'failed' OR (status IN ('expiring','deleting') AND delete_attempts > 0) ORDER BY expires_at LIMIT 50").all(),
    db.prepare("SELECT id, kind, size_bytes, expires_at, removed_at FROM media WHERE status = 'expired' ORDER BY removed_at DESC LIMIT 20").all(),
    db.prepare("SELECT status, purpose, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM media GROUP BY status, purpose").all(),
  ]);
  const lastRun = await getFlag(db, "media_cleanup_last_run");
  return c.json({ now, upcoming: upcoming.results, failed: failed.results, recentExpired: recentExpired.results, byStatus: byStatus.results, lastRun: lastRun ? JSON.parse(lastRun) : null });
});

app.post("/media/retry-failed", async (c) => {
  const a = need(c, "admin");
  const { results } = await c.env.DB.prepare("SELECT id FROM media WHERE status = 'failed' LIMIT 500").all<{ id: string }>();
  if (results.length) {
    await c.env.DB.prepare("UPDATE media SET status = 'deleting' WHERE status = 'failed'").run();
    await enqueue(c.env, "media", { kind: "media.delete", mediaIds: results.map((r) => r.id), key: `retry:${Date.now()}` });
  }
  await audit(c.env, a, "media_retry_failed", "media", null, null, { count: results.length });
  return c.json({ retried: results.length });
});

// ───────────── Reports & moderation ─────────────

app.get("/reports", async (c) => {
  const a = need(c, "moderator", false);
  const { status } = query(c, z.object({ status: z.enum(["open", "actioned", "dismissed"]).default("open") }));
  const { results } = await c.env.DB
    .prepare("SELECT id, reporter_id, target_type, target_id, reason, details, status, resolution, resolved_by, resolved_at, created_at FROM reports WHERE status = ?1 ORDER BY created_at DESC LIMIT 100")
    .bind(status)
    .all<{ id: string; reporter_id: string; target_type: string; target_id: string; reason: string; details: string; status: string; resolution: string | null; resolved_at: number | null; created_at: number }>();
  const people = await getSummaries(c.env.DB, [...results.map((r) => r.reporter_id), ...results.filter((r) => r.target_type === "profile").map((r) => r.target_id)]);
  const posts = await hydratePosts(c.env.DB, a.activeProfileId, results.filter((r) => r.target_type === "post").map((r) => r.target_id), { keepPlaceholders: true });
  const msgIds = results.filter((r) => r.target_type === "message").map((r) => r.target_id);
  const msgs = new Map<string, { text: string | null; sender_id: string }>();
  for (const id of msgIds) {
    const m = await c.env.DB.prepare("SELECT text, sender_id FROM messages WHERE id = ?1").bind(id).first<{ text: string | null; sender_id: string }>();
    if (m) msgs.set(id, m);
  }
  return c.json({
    items: results.map((r) => ({
      ...r,
      reporter: people.get(r.reporter_id) ?? null,
      target: r.target_type === "post" ? (posts.get(r.target_id) ?? null) : r.target_type === "profile" ? (people.get(r.target_id) ?? null) : r.target_type === "message" ? (msgs.get(r.target_id) ?? null) : { id: r.target_id },
    })),
  });
});

app.post("/reports/:id/resolve", async (c) => {
  const a = need(c, "moderator");
  const { action, note } = await body(c, z.object({ action: z.enum(["dismiss", "remove_content", "suspend_profile"]), note: z.string().max(500).default("") }));
  const r = await c.env.DB.prepare("SELECT id, target_type, target_id, status FROM reports WHERE id = ?1").bind(c.req.param("id")).first<{ id: string; target_type: string; target_id: string; status: string }>();
  if (!r) throw notFound();
  const db = c.env.DB;
  if (action === "remove_content") {
    if (r.target_type === "post") await deletePost(c.env, r.target_id, "moderation");
    else if (r.target_type === "message") await db.prepare("UPDATE messages SET text = NULL, deleted_at = ?2 WHERE id = ?1").bind(r.target_id, Date.now()).run();
    else if (r.target_type === "media") await db.prepare("UPDATE media SET moderation_status = 'removed' WHERE id = ?1").bind(r.target_id).run();
    else throw bad("Use suspend for profiles.");
  }
  if (action === "suspend_profile") {
    const pid = r.target_type === "profile" ? r.target_id : r.target_type === "post" ? (await db.prepare("SELECT author_id AS id FROM posts WHERE id = ?1").bind(r.target_id).first<{ id: string }>())?.id : r.target_type === "message" ? (await db.prepare("SELECT sender_id AS id FROM messages WHERE id = ?1").bind(r.target_id).first<{ id: string }>())?.id : (await db.prepare("SELECT owner_id AS id FROM media WHERE id = ?1").bind(r.target_id).first<{ id: string }>())?.id;
    if (pid) await db.prepare("UPDATE profiles SET status = 'suspended' WHERE id = ?1").bind(pid).run();
  }
  await db
    .prepare("UPDATE reports SET status = ?2, resolution = ?3, resolved_by = ?4, resolved_at = ?5 WHERE target_type = ?6 AND target_id = ?7 AND status = 'open'")
    .bind(r.id, action === "dismiss" ? "dismissed" : "actioned", `${action}${note ? `: ${note}` : ""}`, a.identityId, Date.now(), r.target_type, r.target_id)
    .run();
  await audit(c.env, a, `report_${action}`, r.target_type, r.target_id, { status: r.status }, { action, note });
  return c.json({ ok: true });
});

app.get("/audit", async (c) => {
  need(c, "moderator", false);
  const { cursor } = query(c, z.object({ cursor: z.string().max(100).optional() }));
  const cur = decodeCursor<[number, string]>(cursor);
  const { results } = await c.env.DB
    .prepare("SELECT * FROM admin_audit WHERE created_at < ?1 OR (created_at = ?1 AND id < ?2) ORDER BY created_at DESC, id DESC LIMIT 50")
    .bind(cur?.[0] ?? Number.MAX_SAFE_INTEGER, cur?.[1] ?? "~")
    .all<{ id: string; created_at: number }>();
  const last = results[results.length - 1];
  return c.json({ items: results, cursor: results.length === 50 && last ? encodeCursor([last.created_at, last.id]) : null });
});

app.get("/errors", async (c) => {
  need(c, "moderator", false);
  const { results } = await c.env.DB.prepare("SELECT id, level, source, message, data_json, created_at FROM ops_log ORDER BY created_at DESC LIMIT 100").all();
  return c.json({ items: results });
});

export default app;
