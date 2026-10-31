import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, Auth } from "../env";
import { sha256Hex } from "./crypto";
import { randomToken } from "./ids";
import { conflict, forbidden, unauthorized } from "./http";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = "__Host-crew_sid";
const COOKIE_DEV = "crew_sid";

function isHttps(c: Context) {
  return new URL(c.req.url).protocol === "https:";
}

export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, COOKIE_SECURE) ?? getCookie(c, COOKIE_DEV);
}

export async function createSession(c: Context<AppEnv>, identityId: string, profileId: string) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, identity_id, active_profile_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6)",
  )
    .bind(tokenHash, identityId, profileId, now, now + SESSION_TTL_MS, (c.req.header("User-Agent") ?? "").slice(0, 200))
    .run();
  const secure = isHttps(c);
  setCookie(c, secure ? COOKIE_SECURE : COOKIE_DEV, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, COOKIE_SECURE, { path: "/", secure: true });
  deleteCookie(c, COOKIE_DEV, { path: "/" });
}

/** Load session (if any). Never throws for a missing/invalid session. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("auth", null);
  const token = readSessionToken(c);
  if (token && token.length < 200) {
    const tokenHash = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT s.identity_id, s.active_profile_id, s.expires_at, s.last_seen_at, s.elevated_until,
              i.status AS identity_status, p.kind, p.handle, p.status AS profile_status, m.role,
              (SELECT role FROM admin_roles WHERE identity_id = s.identity_id) AS admin_role
       FROM sessions s
       JOIN identities i ON i.id = s.identity_id
       JOIN profile_members m ON m.identity_id = s.identity_id AND m.profile_id = s.active_profile_id
       JOIN profiles p ON p.id = s.active_profile_id
       WHERE s.token_hash = ?1`,
    )
      .bind(tokenHash)
      .first<{
        identity_id: string; active_profile_id: string; expires_at: number; last_seen_at: number; elevated_until: number;
        identity_status: string; kind: Auth["profile"]["kind"]; handle: string; profile_status: string; role: "owner" | "manager";
        admin_role: Auth["adminRole"];
      }>();
    const now = Date.now();
    if (row && row.expires_at > now && row.identity_status === "active") {
      c.set("auth", {
        identityId: row.identity_id,
        tokenHash,
        activeProfileId: row.active_profile_id,
        elevatedUntil: row.elevated_until,
        profile: { id: row.active_profile_id, kind: row.kind, handle: row.handle, status: row.profile_status, role: row.role },
        adminRole: row.admin_role,
      });
      if (now - row.last_seen_at > 5 * 60_000) {
        c.executionCtx.waitUntil(
          c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?1, expires_at = ?2 WHERE token_hash = ?3").bind(now, now + SESSION_TTL_MS, tokenHash).run(),
        );
      }
    } else if (row || token) {
      clearSessionCookie(c);
    }
  }
  await next();
};

export function auth(c: Context<AppEnv>): Auth {
  const a = c.get("auth");
  if (!a) throw unauthorized();
  return a;
}

/**
 * The acting profile. Mutations must carry X-Crew-Profile matching the session's active profile,
 * so a stale tab can never post as a profile the user has since switched away from.
 */
export function actor(c: Context<AppEnv>): Auth {
  const a = auth(c);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const claimed = c.req.header("X-Crew-Profile");
    if (claimed !== a.activeProfileId) throw conflict("Your active profile changed in another tab. Refresh to continue.", "PROFILE_MISMATCH");
  }
  if (a.profile.status !== "active") throw forbidden("This profile is suspended.");
  return a;
}
