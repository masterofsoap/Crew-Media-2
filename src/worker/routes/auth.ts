import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { DISPLAY_NAME_MAX, PIN_MAX, PIN_MIN } from "../../shared/constants";
import { normalizeHandle } from "../../shared/text";
import { body, bad, forbidden, tooMany, unauthorized, HttpError } from "../lib/http";
import { hashSecret, sha256Hex, verifySecret, PIN_ITERATIONS } from "../lib/crypto";
import { humanCode } from "../lib/ids";
import { hit, clientIp } from "../lib/ratelimit";
import { auth, clearSessionCookie, createSession } from "../lib/session";
import { assertHandleAvailable, createProfileStatements, memberRole, sessionInfo } from "../lib/profiles";
import { newId } from "../lib/ids";
import { opsLog } from "../lib/log";
import { verifyTurnstile } from "../lib/turnstile";
import { ensureSeeded } from "../ai/seed";

const pinSchema = z
  .string()
  .regex(new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`), `PIN must be ${PIN_MIN}–${PIN_MAX} digits`);

export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const asc = "01234567890123456789";
  const desc = "98765432109876543210";
  if (asc.includes(pin) || desc.includes(pin)) return true;
  if (pin.length === 4) {
    if (/^(\d\d)\1$/.test(pin)) return true; // 1212, 6969
    if (/^(\d)\1(\d)\2$/.test(pin)) return true; // 1122
    if (/^(19\d\d|20[0-2]\d)$/.test(pin)) return true; // years: birthdays/anniversaries are guessed first
    if (["2580", "0852", "1004", "0007", "1357", "2468", "8520", "5683"].includes(pin)) return true;
  }
  const common = ["123123", "121212", "112233", "696969", "131313", "123321", "654321", "202020", "101010"];
  return common.includes(pin);
}

const LOCK_AFTER = 5;
function lockDuration(failures: number) {
  return Math.min(24 * 3600_000, 60_000 * 2 ** Math.max(0, failures - LOCK_AFTER));
}

async function slowDown() {
  await new Promise((r) => setTimeout(r, 350 + Math.random() * 300));
}

const app = new Hono<AppEnv>();

app.get("/session", async (c) => {
  const a = c.get("auth");
  if (!a) return c.json({ session: null, turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null });
  return c.json({ session: await sessionInfo(c.env, a) });
});

app.post("/register", async (c) => {
  const input = await body(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
      handle: z.string().trim().min(3).max(21),
      pin: pinSchema,
      turnstileToken: z.string().max(4096).optional(),
    }),
  );
  const ipKey = await sha256Hex(clientIp(c.req.raw));
  await hit(c.env.DB, `register:ip:${ipKey}`, 6, 3600_000, { message: "Too many sign-ups from this network. Try again later." });
  await verifyTurnstile(c.env, input.turnstileToken, clientIp(c.req.raw));
  if (isWeakPin(input.pin)) throw bad("That PIN is too easy to guess. Avoid repeats and sequences.", "WEAK_PIN", { pin: "Too easy to guess" });

  const { handle, display } = await assertHandleAvailable(c.env.DB, input.handle);
  const identityId = newId();
  const now = Date.now();
  const pin = await hashSecret(input.pin, c.env.PIN_PEPPER);
  const recoveryCode = humanCode();
  const recoveryHash = await sha256Hex(`${identityId}:${recoveryCode}`);
  const profile = createProfileStatements(c.env.DB, { identityId, kind: "personal", handle, handleDisplay: display, displayName: input.displayName });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO identities (id, pin_hash, pin_salt, pin_iterations, recovery_hash, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      ).bind(identityId, pin.hash, pin.salt, pin.iterations, recoveryHash, now),
      ...profile.stmts,
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "HANDLE_TAKEN", "That handle is already taken.");
    throw e;
  }
  await createSession(c, identityId, profile.id);
  c.executionCtx.waitUntil(ensureSeeded(c.env).catch((e) => opsLog(c.env.DB, "error", "seed", "auto-seed failed", { error: String(e) })));
  const a = { identityId, tokenHash: "", activeProfileId: profile.id, elevatedUntil: 0, adminRole: null, profile: { id: profile.id, kind: "personal" as const, handle, status: "active", role: "owner" as const } };
  return c.json({ session: await sessionInfo(c.env, a), recoveryCode }, 201);
});

app.post("/login", async (c) => {
  const input = await body(c, z.object({ handle: z.string().trim().min(1).max(21), pin: z.string().max(PIN_MAX), turnstileToken: z.string().max(4096).optional() }));
  const ip = clientIp(c.req.raw);
  const ipKey = await sha256Hex(ip);
  const handle = normalizeHandle(input.handle);
  await hit(c.env.DB, `login:ip:${ipKey}`, 30, 15 * 60_000, { message: "Too many sign-in attempts. Try again in a few minutes." });
  await hit(c.env.DB, `login:handle:${handle}`, 10, 15 * 60_000, { message: "Too many sign-in attempts. Try again in a few minutes." });
  await verifyTurnstile(c.env, input.turnstileToken, ip);

  const row = await c.env.DB.prepare(
    `SELECT i.id, i.pin_hash, i.pin_salt, i.pin_iterations, i.failed_attempts, i.locked_until, i.status, p.id AS profile_id
     FROM profiles p
     JOIN profile_members m ON m.profile_id = p.id AND m.role = 'owner'
     JOIN identities i ON i.id = m.identity_id
     WHERE p.handle = ?1 AND p.kind <> 'ai' AND p.status <> 'disabled'`,
  )
    .bind(handle)
    .first<{ id: string; pin_hash: string; pin_salt: string; pin_iterations: number; failed_attempts: number; locked_until: number; status: string; profile_id: string }>();

  const generic = () => new HttpError(401, "INVALID_CREDENTIALS", "That handle and PIN don't match.");
  if (!row) {
    // Equalize timing with the real verification path to avoid handle enumeration.
    await hashSecret(input.pin || "000000", c.env.PIN_PEPPER, "AAAAAAAAAAAAAAAAAAAAAA==", PIN_ITERATIONS);
    await slowDown();
    throw generic();
  }
  const now = Date.now();
  if (row.locked_until > now) {
    await slowDown();
    throw tooMany("Too many sign-in attempts. Try again later or use account recovery.");
  }
  const ok = await verifySecret(input.pin, c.env.PIN_PEPPER, row.pin_hash, row.pin_salt, row.pin_iterations);
  if (!ok) {
    const failures = row.failed_attempts + 1;
    const lockedUntil = failures >= LOCK_AFTER ? now + lockDuration(failures) : 0;
    await c.env.DB.prepare("UPDATE identities SET failed_attempts = ?2, locked_until = ?3 WHERE id = ?1").bind(row.id, failures, lockedUntil).run();
    if (failures >= LOCK_AFTER) await opsLog(c.env.DB, "warn", "auth", "identity temporarily locked", { identity: row.id, failures });
    await slowDown();
    throw generic();
  }
  if (row.status !== "active") throw forbidden("This account is suspended. Contact an administrator.");
  await c.env.DB.prepare("UPDATE identities SET failed_attempts = 0, locked_until = 0, last_login_at = ?2 WHERE id = ?1").bind(row.id, now).run();
  await createSession(c, row.id, row.profile_id);
  const role = await c.env.DB.prepare("SELECT role FROM admin_roles WHERE identity_id = ?1").bind(row.id).first<{ role: "owner" | "admin" | "moderator" }>();
  return c.json({
    session: await sessionInfo(c.env, { identityId: row.id, tokenHash: "", activeProfileId: row.profile_id, elevatedUntil: 0, adminRole: role?.role ?? null, profile: { id: row.profile_id, kind: "personal", handle, status: "active", role: "owner" } }),
  });
});

app.post("/logout", async (c) => {
  const a = c.get("auth");
  if (a) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(a.tokenHash).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.post("/logout-all", async (c) => {
  const a = auth(c);
  await c.env.DB.prepare("DELETE FROM sessions WHERE identity_id = ?1").bind(a.identityId).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/** Switch the session's active profile. Membership is verified server-side. */
app.post("/switch", async (c) => {
  const a = auth(c);
  const { profileId } = await body(c, z.object({ profileId: z.string().min(1).max(40) }));
  const role = await memberRole(c.env.DB, a.identityId, profileId);
  if (!role) throw forbidden("You can't act as that profile.");
  const p = await c.env.DB.prepare("SELECT kind, handle, status FROM profiles WHERE id = ?1").bind(profileId).first<{ kind: "personal" | "business" | "ai"; handle: string; status: string }>();
  if (!p || p.status === "disabled") throw forbidden("That profile is unavailable.");
  await c.env.DB.prepare("UPDATE sessions SET active_profile_id = ?2 WHERE token_hash = ?1").bind(a.tokenHash, profileId).run();
  return c.json({ session: await sessionInfo(c.env, { ...a, activeProfileId: profileId, profile: { id: profileId, kind: p.kind, handle: p.handle, status: p.status, role } }) });
});

/**
 * Recovery: handle + one-time recovery code (issued at sign-up), or an admin-issued reset code.
 * Knowing only a display name/handle is never enough. Successful recovery rotates the code and
 * revokes every existing session.
 */
app.post("/recover", async (c) => {
  const input = await body(c, z.object({ handle: z.string().trim().min(1).max(21), code: z.string().trim().min(8).max(64), newPin: pinSchema, turnstileToken: z.string().max(4096).optional() }));
  const ipKey = await sha256Hex(clientIp(c.req.raw));
  await hit(c.env.DB, `recover:ip:${ipKey}`, 10, 3600_000, { message: "Too many recovery attempts. Try again later." });
  const handle = normalizeHandle(input.handle);
  await hit(c.env.DB, `recover:handle:${handle}`, 5, 3600_000, { message: "Too many recovery attempts. Try again later." });
  await verifyTurnstile(c.env, input.turnstileToken, clientIp(c.req.raw));
  if (isWeakPin(input.newPin)) throw bad("That PIN is too easy to guess.", "WEAK_PIN", { newPin: "Too easy to guess" });

  const row = await c.env.DB.prepare(
    `SELECT i.id, i.recovery_hash, p.id AS profile_id FROM profiles p
     JOIN profile_members m ON m.profile_id = p.id AND m.role = 'owner'
     JOIN identities i ON i.id = m.identity_id WHERE p.handle = ?1 AND p.kind <> 'ai'`,
  )
    .bind(handle)
    .first<{ id: string; recovery_hash: string | null; profile_id: string }>();
  const code = input.code.toUpperCase().replace(/\s+/g, "");
  let valid = false;
  let adminTokenId: string | null = null;
  if (row) {
    if (row.recovery_hash && (await sha256Hex(`${row.id}:${code}`)) === row.recovery_hash) valid = true;
    else {
      const t = await c.env.DB.prepare("SELECT id FROM recovery_tokens WHERE identity_id = ?1 AND token_hash = ?2 AND used_at IS NULL AND expires_at > ?3")
        .bind(row.id, await sha256Hex(`reset:${code}`), Date.now())
        .first<{ id: string }>();
      if (t) {
        valid = true;
        adminTokenId = t.id;
      }
    }
  }
  if (!row || !valid) {
    await slowDown();
    throw new HttpError(401, "INVALID_RECOVERY", "That handle and recovery code don't match.");
  }
  const pin = await hashSecret(input.newPin, c.env.PIN_PEPPER);
  const newCode = humanCode();
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare("UPDATE identities SET pin_hash = ?2, pin_salt = ?3, pin_iterations = ?4, recovery_hash = ?5, failed_attempts = 0, locked_until = 0 WHERE id = ?1")
      .bind(row.id, pin.hash, pin.salt, pin.iterations, await sha256Hex(`${row.id}:${newCode}`)),
    c.env.DB.prepare("DELETE FROM sessions WHERE identity_id = ?1").bind(row.id),
  ];
  if (adminTokenId) stmts.push(c.env.DB.prepare("UPDATE recovery_tokens SET used_at = ?2 WHERE id = ?1").bind(adminTokenId, now));
  await c.env.DB.batch(stmts);
  await opsLog(c.env.DB, "warn", "auth", "account recovered", { identity: row.id, via: adminTokenId ? "admin_token" : "recovery_code" });
  await createSession(c, row.id, row.profile_id);
  const role = await c.env.DB.prepare("SELECT role FROM admin_roles WHERE identity_id = ?1").bind(row.id).first<{ role: "owner" | "admin" | "moderator" }>();
  return c.json({
    recoveryCode: newCode,
    session: await sessionInfo(c.env, { identityId: row.id, tokenHash: "", activeProfileId: row.profile_id, elevatedUntil: 0, adminRole: role?.role ?? null, profile: { id: row.profile_id, kind: "personal", handle, status: "active", role: "owner" } }),
  });
});

async function requirePin(env: Env, identityId: string, pin: string) {
  await hit(env.DB, `pincheck:${identityId}`, 8, 15 * 60_000, { message: "Too many PIN attempts. Try again later." });
  const i = await env.DB.prepare("SELECT pin_hash, pin_salt, pin_iterations FROM identities WHERE id = ?1").bind(identityId).first<{ pin_hash: string; pin_salt: string; pin_iterations: number }>();
  if (!i || !(await verifySecret(pin, env.PIN_PEPPER, i.pin_hash, i.pin_salt, i.pin_iterations))) {
    await slowDown();
    throw unauthorized("That PIN is incorrect.");
  }
}

app.post("/change-pin", async (c) => {
  const a = auth(c);
  const input = await body(c, z.object({ currentPin: z.string().max(PIN_MAX), newPin: pinSchema }));
  await requirePin(c.env, a.identityId, input.currentPin);
  if (isWeakPin(input.newPin)) throw bad("That PIN is too easy to guess.", "WEAK_PIN", { newPin: "Too easy to guess" });
  const pin = await hashSecret(input.newPin, c.env.PIN_PEPPER);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE identities SET pin_hash = ?2, pin_salt = ?3, pin_iterations = ?4 WHERE id = ?1").bind(a.identityId, pin.hash, pin.salt, pin.iterations),
    c.env.DB.prepare("DELETE FROM sessions WHERE identity_id = ?1 AND token_hash <> ?2").bind(a.identityId, a.tokenHash),
  ]);
  return c.json({ ok: true });
});

app.post("/recovery-code", async (c) => {
  const a = auth(c);
  const { pin } = await body(c, z.object({ pin: z.string().max(PIN_MAX) }));
  await requirePin(c.env, a.identityId, pin);
  const code = humanCode();
  await c.env.DB.prepare("UPDATE identities SET recovery_hash = ?2 WHERE id = ?1").bind(a.identityId, await sha256Hex(`${a.identityId}:${code}`)).run();
  return c.json({ recoveryCode: code });
});

app.get("/sessions", async (c) => {
  const a = auth(c);
  const { results } = await c.env.DB.prepare("SELECT token_hash, created_at, last_seen_at, user_agent FROM sessions WHERE identity_id = ?1 AND expires_at > ?2 ORDER BY last_seen_at DESC")
    .bind(a.identityId, Date.now())
    .all<{ token_hash: string; created_at: number; last_seen_at: number; user_agent: string | null }>();
  return c.json({ items: results.map((s) => ({ current: s.token_hash === a.tokenHash, createdAt: s.created_at, lastSeenAt: s.last_seen_at, userAgent: s.user_agent ?? "" })) });
});

export { requirePin };
export default app;
