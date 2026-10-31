import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { IMAGE_MAX_BYTES, MEDIA_TTL_MS, THUMB_MAX_BYTES, VIDEO_MAX_BYTES } from "../../shared/constants";
import { actor, auth } from "../lib/session";
import { bad, forbidden, notFound, query, HttpError } from "../lib/http";
import { hit } from "../lib/ratelimit";
import { getConfig } from "../lib/settings";
import { newId, randomToken } from "../lib/ids";
import { declaredMatches, mediaHeaders, parseRange, peekStream, sniff } from "../lib/media";
import { hydratePosts, toMediaView } from "../lib/views";

const app = new Hono<AppEnv>();

/**
 * Server-authorized upload. The body is streamed straight to R2 (never buffered whole) after the
 * first bytes are sniffed; the declared Content-Type must match the sniffed type and the exact
 * Content-Length is enforced by a FixedLengthStream.
 * Post and message media get expires_at = upload time + 7 days. Profile assets don't expire.
 */
app.post("/", async (c) => {
  const a = actor(c);
  const { purpose, alt, width, height } = query(
    c,
    z.object({
      purpose: z.enum(["post", "message", "profile"]),
      alt: z.string().max(400).default(""),
      width: z.coerce.number().int().min(1).max(20000).optional(),
      height: z.coerce.number().int().min(1).max(20000).optional(),
    }),
  );
  const cfg = await getConfig(c.env.DB);
  await hit(c.env.DB, `upload:${a.activeProfileId}`, cfg.limits.uploadsPerHour, 3600_000, { message: "Upload limit reached. Try again later." });
  const len = Number(c.req.header("Content-Length") ?? "NaN");
  const declared = c.req.header("Content-Type") ?? "";
  if (!Number.isFinite(len) || len <= 0) throw new HttpError(411, "LENGTH_REQUIRED", "Upload size is required.");
  if (len > VIDEO_MAX_BYTES) throw new HttpError(413, "TOO_LARGE", `Files can be up to ${VIDEO_MAX_BYTES / 1024 / 1024} MB.`);
  if (!c.req.raw.body) throw bad("Empty upload.");

  const { head, stream } = await peekStream(c.req.raw.body);
  const kind = sniff(head);
  if (!kind) throw new HttpError(415, "UNSUPPORTED_MEDIA", "Only JPEG, PNG, GIF, WebP images and MP4, WebM, MOV videos are supported.");
  if (!declaredMatches(declared, kind.mime)) throw new HttpError(415, "TYPE_MISMATCH", "The file's contents don't match its type.");
  if (kind.kind === "image" && len > IMAGE_MAX_BYTES) throw new HttpError(413, "TOO_LARGE", `Images can be up to ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
  if (purpose === "profile" && kind.kind !== "image") throw bad("Profile artwork must be an image.");

  const id = newId();
  const key = `m/${a.activeProfileId}/${randomToken(18)}`;
  const fixed = new FixedLengthStream(len);
  const pipe = stream.pipeTo(fixed.writable);
  await Promise.all([c.env.MEDIA.put(key, fixed.readable, { httpMetadata: { contentType: kind.mime } }), pipe]);
  const now = Date.now();
  const expiresAt = purpose === "profile" ? null : now + MEDIA_TTL_MS;
  await c.env.DB
    .prepare(
      `INSERT INTO media (id, owner_id, purpose, r2_key, kind, mime, size_bytes, width, height, alt_text, created_at, expires_at, attached_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(id, a.activeProfileId, purpose, key, kind.kind, kind.mime, len, width ?? null, height ?? null, alt, now, expiresAt, purpose === "profile" ? now : null)
    .run();
  return c.json(
    toMediaView({ id, post_id: null, message_id: null, kind: kind.kind, width: width ?? null, height: height ?? null, alt_text: alt, status: "ready", moderation_status: "ok", expires_at: expiresAt, thumb_key: null }),
    201,
  );
});

/** Attach a client-generated thumbnail/poster (image only, small) to the uploader's media. */
app.put("/:id/thumb", async (c) => {
  const a = actor(c);
  const m = await c.env.DB.prepare("SELECT id, owner_id, thumb_key, status FROM media WHERE id = ?1").bind(c.req.param("id")).first<{ id: string; owner_id: string; thumb_key: string | null; status: string }>();
  if (!m || m.owner_id !== a.activeProfileId) throw notFound();
  if (m.status !== "ready") throw bad("This media is no longer available.");
  const len = Number(c.req.header("Content-Length") ?? "NaN");
  if (!Number.isFinite(len) || len <= 0 || len > THUMB_MAX_BYTES) throw new HttpError(413, "TOO_LARGE", "Thumbnail too large.");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  const kind = sniff(buf);
  if (!kind || kind.kind !== "image" || kind.mime === "image/gif") throw new HttpError(415, "UNSUPPORTED_MEDIA", "Thumbnails must be JPEG, PNG or WebP.");
  const key = m.thumb_key ?? `t/${a.activeProfileId}/${randomToken(18)}`;
  await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType: kind.mime } });
  await c.env.DB.prepare("UPDATE media SET thumb_key = ?2 WHERE id = ?1").bind(m.id, key).run();
  return c.json({ ok: true });
});

/** Discard an unattached upload (e.g. removed from the composer). */
app.delete("/:id", async (c) => {
  const a = actor(c);
  const m = await c.env.DB.prepare("SELECT id, owner_id, r2_key, thumb_key, post_id, message_id FROM media WHERE id = ?1").bind(c.req.param("id")).first<{ id: string; owner_id: string; r2_key: string; thumb_key: string | null; post_id: string | null; message_id: string | null }>();
  if (!m || m.owner_id !== a.activeProfileId) throw notFound();
  if (m.post_id || m.message_id) throw bad("Delete the post or message to remove attached media.");
  await c.env.MEDIA.delete([m.r2_key, ...(m.thumb_key ? [m.thumb_key] : [])]);
  await c.env.DB.prepare("UPDATE media SET status = 'deleted', removed_at = ?2 WHERE id = ?1").bind(m.id, Date.now()).run();
  return c.json({ ok: true });
});

interface ServeRow {
  id: string; owner_id: string; purpose: string; post_id: string | null; message_id: string | null; r2_key: string; thumb_key: string | null;
  mime: string; size_bytes: number; status: string; moderation_status: string; expires_at: number | null;
}

/**
 * Authorized delivery. Every request re-checks: session, expiry (time-based, so expired media is
 * never served even if R2 cleanup is delayed), moderation, and access to the owning post/message.
 */
async function authorize(c: Context<AppEnv>, id: string): Promise<ServeRow> {
  const a = auth(c);
  const m = await c.env.DB.prepare("SELECT id, owner_id, purpose, post_id, message_id, r2_key, thumb_key, mime, size_bytes, status, moderation_status, expires_at FROM media WHERE id = ?1")
    .bind(id)
    .first<ServeRow>();
  if (!m) throw notFound();
  if (m.status !== "ready" || m.moderation_status === "removed") throw new HttpError(410, "GONE", "This media is no longer available.");
  if (m.expires_at !== null && m.expires_at <= Date.now()) throw new HttpError(410, "EXPIRED", "Media expired after 7 days.");
  if (m.purpose === "profile") return m;
  if (m.purpose === "post") {
    if (!m.post_id) {
      const mine = await c.env.DB.prepare("SELECT 1 FROM profile_members WHERE identity_id = ?1 AND profile_id = ?2").bind(a.identityId, m.owner_id).first();
      if (!mine) throw notFound();
      return m;
    }
    const visible = await hydratePosts(c.env.DB, a.activeProfileId, [m.post_id]);
    if (!visible.has(m.post_id)) throw notFound();
    return m;
  }
  // Direct-message media: the identity must act as a current member of the conversation.
  if (!m.message_id) {
    const mine = await c.env.DB.prepare("SELECT 1 FROM profile_members WHERE identity_id = ?1 AND profile_id = ?2").bind(a.identityId, m.owner_id).first();
    if (!mine) throw notFound();
    return m;
  }
  const member = await c.env.DB.prepare(
    `SELECT 1 FROM messages msg JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id
     JOIN profile_members pm ON pm.profile_id = cm.profile_id AND pm.identity_id = ?2
     WHERE msg.id = ?1 AND msg.deleted_at IS NULL AND cm.left_at IS NULL LIMIT 1`,
  )
    .bind(m.message_id, a.identityId)
    .first();
  if (!member) throw forbidden();
  return m;
}

app.get("/:id", async (c) => {
  const m = await authorize(c, c.req.param("id"));
  const maxAge = m.expires_at ? Math.min(3600, (m.expires_at - Date.now()) / 1000) : 3600;
  const range = parseRange(c.req.header("Range") ?? null, m.size_bytes);
  const obj = await c.env.MEDIA.get(m.r2_key, range ? { range } : undefined);
  if (!obj) throw new HttpError(410, "GONE", "This media is no longer available.");
  const headers = mediaHeaders(m.mime, range ? range.length : m.size_bytes, maxAge);
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${m.size_bytes}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
});

app.get("/:id/thumb", async (c) => {
  const m = await authorize(c, c.req.param("id"));
  if (!m.thumb_key) throw notFound();
  const obj = await c.env.MEDIA.get(m.thumb_key);
  if (!obj) throw notFound();
  const maxAge = m.expires_at ? Math.min(3600, (m.expires_at - Date.now()) / 1000) : 3600;
  return new Response(obj.body, { headers: mediaHeaders(obj.httpMetadata?.contentType ?? "image/jpeg", obj.size, maxAge) });
});

export default app;
