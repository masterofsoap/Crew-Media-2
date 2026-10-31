import { normalizeHandle, isValidHandle } from "../../shared/text";
import { defaultAppearance } from "../../shared/appearance";
import { DEFAULT_THEME_ID } from "../../shared/themes";
import type { OwnedProfile, SessionInfo } from "../../shared/types";
import type { Auth } from "../env";
import { bad, conflict } from "./http";
import { newId } from "./ids";
import { PROFILE_SUMMARY_COLS, toSummary, type ProfileSummaryRow } from "./views";

const RESERVED = new Set(["admin", "administrator", "root", "support", "help", "api", "settings", "explore", "home", "crew", "crewplus", "system", "moderator", "official", "null", "undefined", "me", "login", "signup", "notifications", "messages", "search"]);

export async function assertHandleAvailable(db: D1Database, rawHandle: string): Promise<{ handle: string; display: string }> {
  const display = rawHandle.trim().replace(/^@/, "");
  if (!isValidHandle(display)) throw bad("Handles are 3–20 letters, numbers or underscores.", "VALIDATION", { handle: "Invalid handle" });
  const handle = normalizeHandle(display);
  if (RESERVED.has(handle)) throw conflict("That handle is reserved.", "HANDLE_TAKEN");
  const exists = await db.prepare("SELECT 1 FROM profiles WHERE handle = ?1").bind(handle).first();
  if (exists) throw conflict("That handle is already taken.", "HANDLE_TAKEN");
  return { handle, display };
}

export interface NewProfile {
  identityId: string | null;
  kind: "personal" | "business" | "ai";
  aiClass?: "persona" | "audience";
  handle: string;
  handleDisplay: string;
  displayName: string;
  bio?: string;
  interests?: string[];
  themeId?: string;
  createdAt?: number;
  allowAiDms?: boolean;
  dmPolicy?: "everyone" | "following" | "none";
}

/** Statements that create a profile (+ owner membership + score row). Run inside a db.batch for atomicity. */
export function createProfileStatements(db: D1Database, p: NewProfile): { id: string; stmts: D1PreparedStatement[] } {
  const id = newId(p.createdAt);
  const now = p.createdAt ?? Date.now();
  const themeId = p.themeId ?? DEFAULT_THEME_ID;
  const stmts = [
    db.prepare(
      `INSERT INTO profiles (id, handle, handle_display, display_name, bio, kind, ai_class, avatar_seed, theme_id, appearance_json, interests, dm_policy, allow_ai_dms, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    ).bind(
      id, p.handle, p.handleDisplay, p.displayName, p.bio ?? "", p.kind, p.aiClass ?? null, newId(), themeId,
      JSON.stringify(defaultAppearance(themeId)), (p.interests ?? []).join(","), p.dmPolicy ?? (p.kind === "ai" ? "everyone" : "following"),
      p.allowAiDms === false ? 0 : 1, now,
    ),
    db.prepare("INSERT INTO profile_scores (profile_id, updated_at) VALUES (?1, ?2)").bind(id, now),
  ];
  if (p.identityId) {
    stmts.push(db.prepare("INSERT INTO profile_members (profile_id, identity_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)").bind(id, p.identityId, now));
  }
  return { id, stmts };
}

export async function ownedProfiles(db: D1Database, identityId: string): Promise<OwnedProfile[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PROFILE_SUMMARY_COLS}, m.role,
        (SELECT COUNT(*) FROM notifications n WHERE n.recipient_id = p.id AND n.read_at IS NULL) AS unread_n,
        (SELECT COUNT(*) FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
           WHERE cm.profile_id = p.id AND cm.left_at IS NULL AND cm.muted = 0 AND c.last_message_at > cm.last_read_at) AS unread_m
       FROM profile_members m JOIN profiles p ON p.id = m.profile_id
       WHERE m.identity_id = ?1 AND p.status <> 'disabled'
       ORDER BY m.created_at`,
    )
    .bind(identityId)
    .all<ProfileSummaryRow & { role: "owner" | "manager"; unread_n: number; unread_m: number }>();
  return results.map((r) => ({ ...toSummary(r), role: r.role, unreadNotifications: r.unread_n, unreadMessages: r.unread_m }));
}

export async function sessionInfo(env: Env, a: Auth): Promise<SessionInfo> {
  const profiles = await ownedProfiles(env.DB, a.identityId);
  let admin: SessionInfo["admin"] = null;
  if (a.adminRole) {
    const r = await env.DB.prepare("SELECT admin_secret_hash IS NOT NULL AS has FROM identities WHERE id = ?1").bind(a.identityId).first<{ has: number }>();
    admin = { role: a.adminRole, elevated: a.elevatedUntil > Date.now(), hasPassphrase: !!r?.has };
  }
  return {
    identityId: a.identityId,
    activeProfileId: a.activeProfileId,
    profiles,
    admin,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
  };
}

/** Membership check for acting as a profile. */
export async function memberRole(db: D1Database, identityId: string, profileId: string): Promise<"owner" | "manager" | null> {
  const r = await db.prepare("SELECT role FROM profile_members WHERE identity_id = ?1 AND profile_id = ?2").bind(identityId, profileId).first<{ role: "owner" | "manager" }>();
  return r?.role ?? null;
}
