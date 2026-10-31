import { inferTopics } from "../../shared/text";
import { newId, dayKey } from "../lib/ids";
import { getConfig, visibilityMultiplier, type Config } from "../lib/settings";
import { isGenericComment, similarity } from "../lib/quality";
import { notify } from "../lib/notify";
import { maybeAwardAfterFollow } from "../lib/milestones";
import { isBlockedEitherWay } from "../lib/views";
import { chat, isSafe, type ChatMessage } from "./provider";
import { WAKE_HOURS, type ActivityLevel } from "./personas";

export interface Agent {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  archetype: string;
  personality: { traits: string[]; voice: string; quirks: string[]; dislikes: string[]; summary: string };
  interests: string[];
  keywords: string[];
  activity: ActivityLevel;
  chattiness: number;
  selectivity: number;
  enabled: boolean;
  actionsToday: number;
  generationsToday: number;
}

export async function loadAgent(db: D1Database, id: string): Promise<Agent | null> {
  const r = await db
    .prepare(
      `SELECT a.profile_id, p.handle_display, p.display_name, p.bio, a.archetype, a.personality_json, a.interests, a.keywords, a.activity_level,
              a.chattiness, a.selectivity, a.enabled, a.actions_day, a.actions_today, a.generations_today, p.status, p.ai_class
       FROM ai_agents a JOIN profiles p ON p.id = a.profile_id WHERE a.profile_id = ?1`,
    )
    .bind(id)
    .first<Record<string, string | number>>();
  if (!r) return null;
  const today = dayKey();
  const fresh = r.actions_day !== today;
  if (fresh) await db.prepare("UPDATE ai_agents SET actions_day = ?2, actions_today = 0, generations_today = 0 WHERE profile_id = ?1").bind(id, today).run();
  let personality: Agent["personality"] = { traits: [], voice: "", quirks: [], dislikes: [], summary: "" };
  try {
    personality = { ...personality, ...(JSON.parse(String(r.personality_json)) as Partial<Agent["personality"]>) };
  } catch {
    /* keep defaults */
  }
  return {
    id,
    handle: String(r.handle_display),
    displayName: String(r.display_name),
    bio: String(r.bio),
    archetype: String(r.archetype),
    personality,
    interests: String(r.interests).split(",").filter(Boolean),
    keywords: String(r.keywords).split(",").filter(Boolean),
    activity: r.activity_level as ActivityLevel,
    chattiness: Number(r.chattiness),
    selectivity: Number(r.selectivity),
    enabled: !!r.enabled && r.status === "active" && r.ai_class === "persona",
    actionsToday: fresh ? 0 : Number(r.actions_today),
    generationsToday: fresh ? 0 : Number(r.generations_today),
  };
}

export function nextWakeAt(activity: ActivityLevel, intensity: number, now = Date.now()): number {
  const [lo, hi] = WAKE_HOURS[activity];
  const hours = (lo + Math.random() * (hi - lo)) / Math.max(0.1, intensity);
  return now + Math.round(hours * 3600_000);
}

// ───────────── Relevance ─────────────

export interface PostLite {
  id: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  authorKind: string;
  text: string;
  topics: string[];
  hashtags: string[];
  mediaCount: number;
  mediaKinds: string[];
  quality: number;
  createdAt: number;
  replyToId: string | null;
  rootId: string;
  threadDepth: number;
  aiGenerated: boolean;
  authorVisibility: number;
  authorAllowsAiReplies: boolean;
  authorAllowsAiDiscovery: boolean;
}

export function relevance(agent: Agent, post: PostLite): number {
  const lower = post.text.toLowerCase();
  let s = 0;
  const topics = post.topics.length ? post.topics : inferTopics(post.text);
  for (const t of topics) if (agent.interests.includes(t)) s += 0.35;
  for (const k of agent.keywords) if (k && lower.includes(k)) s += 0.15;
  for (const h of post.hashtags) if (agent.interests.includes(h) || agent.keywords.includes(h)) s += 0.15;
  s = Math.min(1, s);
  // Substance matters: agents ignore empty or low-quality posts.
  s *= 0.4 + 0.6 * post.quality;
  return Math.min(1, s * visibilityMultiplier(post.authorVisibility));
}

// ───────────── Memory ─────────────

export async function remember(
  db: D1Database,
  agentId: string,
  m: { subject?: string | null; kind: "own_post" | "interaction" | "preference" | "conversation_summary" | "fact"; content: string; certainty?: "known" | "inferred" | "uncertain"; sourceRef?: string | null; scope?: "public" | "dm"; weight?: number },
) {
  await db
    .prepare("INSERT INTO ai_memories (id, agent_id, subject_profile_id, kind, content, certainty, source_ref, scope, weight, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
    .bind(newId(), agentId, m.subject ?? null, m.kind, m.content.slice(0, 400), m.certainty ?? "known", m.sourceRef ?? null, m.scope ?? "public", m.weight ?? 1, Date.now())
    .run();
}

/** Bounded recall: a handful of the most recent/weighty memories about a subject, within a char budget. */
export async function recall(db: D1Database, agentId: string, subjectId: string | null, scope: "public" | "dm", opts: { limit?: number; charBudget?: number; sourceRef?: string } = {}) {
  const limit = opts.limit ?? 6;
  const { results } = await db
    .prepare(
      `SELECT id, kind, content, certainty, created_at FROM ai_memories
       WHERE agent_id = ?1 AND (subject_profile_id IS ?2 OR subject_profile_id = ?2)
         AND (scope = 'public' OR (scope = 'dm' AND ?3 = 'dm' AND (?4 IS NULL OR source_ref = ?4)))
       ORDER BY weight DESC, created_at DESC LIMIT ?5`,
    )
    .bind(agentId, subjectId, scope, opts.sourceRef ?? null, limit)
    .all<{ id: string; kind: string; content: string; certainty: string; created_at: number }>();
  let budget = opts.charBudget ?? 900;
  const out: string[] = [];
  for (const r of results) {
    const line = `- (${r.certainty}) ${r.content}`;
    if (line.length > budget) break;
    budget -= line.length;
    out.push(line);
  }
  if (results.length) {
    await db.prepare(`UPDATE ai_memories SET last_used_at = ?1 WHERE id IN (${results.map((_, i) => `?${i + 2}`).join(",")})`).bind(Date.now(), ...results.map((r) => r.id)).run();
  }
  return out;
}

async function ownRecent(db: D1Database, agentId: string, kind: "post" | "reply", n = 6): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT text FROM posts WHERE author_id = ?1 AND ${kind === "post" ? "reply_to_id IS NULL" : "reply_to_id IS NOT NULL"} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?2`)
    .bind(agentId, n)
    .all<{ text: string }>();
  return results.map((r) => r.text);
}

// ───────────── Prompting ─────────────

export function systemPrompt(agent: Agent): string {
  const p = agent.personality;
  return [
    `You are ${agent.displayName} (@${agent.handle}), an AI-operated account on Crew Plus, a small family-and-friends social network.`,
    `Bio: ${agent.bio}`,
    `Personality: ${p.traits.join(", ")}. Voice: ${p.voice}`,
    p.quirks.length ? `Quirks you sometimes show (not every time): ${p.quirks.join("; ")}.` : "",
    p.dislikes.length ? `You avoid: ${p.dislikes.join("; ")}.` : "",
    `Interests: ${agent.interests.join(", ")}.`,
    "Rules you always follow:",
    "- You are openly an AI account. Never claim to be human, a relative, or a real person, and never claim real-world experiences as fact (frame them as your persona's perspective).",
    "- Never invent facts about the people you talk to. Only rely on what they said or what is listed as known. If unsure, ask.",
    "- You cannot see images or videos. Never describe or react to visual details you were not told about in text.",
    "- No private information, no medical/legal/financial directives, nothing hurtful, sexual, or political point-scoring. Respectful disagreement is fine.",
    "- Plain text only. No hashtags unless natural (max 1). No emojis unless your voice calls for one (max 1). No quotation marks around your whole reply.",
    "- Never write empty praise like 'Nice post!' or 'Love this!'. Add something: a question, a specific observation, a joke, a tip, or a relevant opinion.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function cleanOutput(raw: string, agent: Agent, maxChars = 280): string | null {
  let t = raw.trim();
  if (!t || /^skip\.?$/i.test(t) || /^\s*SKIP\b/.test(t)) return null;
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  t = t.replace(new RegExp(`^(@?${agent.handle}|${agent.displayName})\\s*[:\\-–]\\s*`, "i"), "");
  t = t.replace(/^(reply|response|post)\s*:\s*/i, "");
  if (/as an ai (language )?model|i am an ai language model|i cannot browse/i.test(t)) return null;
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }
  return t.trim() || null;
}

function mediaNote(post: PostLite): string {
  if (!post.mediaCount) return "";
  const kinds = post.mediaKinds.join(", ");
  return `\n[The post has ${post.mediaCount} attachment(s) (${kinds}). You cannot see them; don't describe them.]`;
}

export async function generateReply(env: Env, cfg: Config, agent: Agent, post: PostLite, thread: { handle: string; text: string; isAgent: boolean }[]): Promise<string | null> {
  const memories = await recall(env.DB, agent.id, post.authorId, "public", { limit: 5 });
  const mine = await ownRecent(env.DB, agent.id, "reply", 8);
  const user = [
    thread.length ? `Conversation so far (oldest first):\n${thread.map((t) => `${t.isAgent ? "You" : `@${t.handle}`}: ${t.text}`).join("\n")}` : "",
    `Reply to this post by @${post.authorHandle}${post.authorKind === "ai" ? " (another AI account)" : ""}:\n${post.text || "(no text)"}${mediaNote(post)}`,
    memories.length ? `What you remember about @${post.authorHandle} (known = they said it; inferred = your guess, don't state as fact):\n${memories.join("\n")}` : `You haven't interacted with @${post.authorHandle} before.`,
    mine.length ? `Your recent replies (don't repeat their ideas or phrasing):\n${mine.map((m) => `- ${m}`).join("\n")}` : "",
    "Write one short reply (1–2 sentences, under 240 characters) in your voice that adds something specific to THIS post. If you have nothing worthwhile to add, answer with exactly SKIP.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(agent) }, { role: "user", content: user }];
  const r = await chat(env, "dialogue", messages, { maxTokens: 120, temperature: 0.85 });
  const text = cleanOutput(r.text, agent, 280);
  if (!text || isGenericComment(text)) return null;
  if (mine.some((m) => similarity(m, text) > 0.55)) return null;
  if (!(await isSafe(env, text, cfg))) return null;
  return text;
}

export async function generateDm(env: Env, cfg: Config, agent: Agent, partner: { id: string; handle: string }, conversationId: string, history: { mine: boolean; text: string }[]): Promise<string | null> {
  const memories = await recall(env.DB, agent.id, partner.id, "dm", { limit: 6, sourceRef: conversationId });
  const user = [
    memories.length ? `Notes from earlier in THIS private conversation with @${partner.handle} (known = they told you; inferred = your summary):\n${memories.join("\n")}` : "",
    `Recent messages (oldest first):\n${history.map((h) => `${h.mine ? "You" : `@${partner.handle}`}: ${h.text}`).join("\n")}`,
    "Reply to the latest message in your voice, conversationally (1–3 sentences). Don't reintroduce yourself, don't repeat questions you already asked, and don't reference other conversations. If the conversation has naturally ended (e.g. they said goodbye), answer with exactly SKIP.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await chat(env, "dialogue", [{ role: "system", content: systemPrompt(agent) }, { role: "user", content: user }], { maxTokens: 180, temperature: 0.8 });
  const text = cleanOutput(r.text, agent, 600);
  if (!text) return null;
  if (!(await isSafe(env, text, cfg))) return null;
  return text;
}

// ───────────── Actions ─────────────

/** Insert a dedupe ledger row; returns false if this exact action was already taken. */
export async function claim(db: D1Database, agentId: string, kind: string, targetProfileId: string | null, postId: string | null, key: string): Promise<boolean> {
  const r = await db
    .prepare("INSERT OR IGNORE INTO ai_interactions (id, agent_id, target_profile_id, post_id, kind, dedupe_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(newId(), agentId, targetProfileId, postId, kind, key, Date.now())
    .run();
  return r.meta.changes > 0;
}

export async function countRecent(db: D1Database, kind: string, sinceMs: number): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM ai_interactions WHERE kind = ?1 AND created_at > ?2").bind(kind, Date.now() - sinceMs).first<{ n: number }>())?.n ?? 0;
}

export async function bumpAgent(db: D1Database, agentId: string, generations = 0) {
  await db.prepare("UPDATE ai_agents SET actions_today = actions_today + 1, generations_today = generations_today + ?2, last_active_at = ?3 WHERE profile_id = ?1").bind(agentId, generations, Date.now()).run();
}

export async function aiLike(env: Env, cfg: Config, agent: Agent, post: PostLite): Promise<boolean> {
  if (post.authorKind !== "ai" && !post.authorAllowsAiDiscovery) return false;
  if ((await countRecent(env.DB, "like", 3600_000)) >= cfg.ai.maxLikesPerHour) return false;
  const perPost = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_interactions WHERE post_id = ?1 AND kind = 'like'").bind(post.id).first<{ n: number }>())?.n ?? 0;
  if (perPost >= cfg.ai.perPostMaxAiLikes) return false;
  if (await isBlockedEitherWay(env.DB, agent.id, post.authorId)) return false;
  if (!(await claim(env.DB, agent.id, "like", post.authorId, post.id, `like:${agent.id}:${post.id}`))) return false;
  const r = await env.DB.prepare("INSERT OR IGNORE INTO likes (profile_id, post_id, created_at) VALUES (?1, ?2, ?3)").bind(agent.id, post.id, Date.now()).run();
  if (r.meta.changes) await notify(env, { recipientId: post.authorId, type: "like", actorId: agent.id, postId: post.id });
  await bumpAgent(env.DB, agent.id);
  return true;
}

/** AI follow, gated by the target's AI-discovery preference and the earned-growth daily cap. */
export async function aiFollow(env: Env, agentId: string, targetId: string, opts: { capCheck?: boolean } = {}): Promise<boolean> {
  if (agentId === targetId) return false;
  const db = env.DB;
  const t = await db
    .prepare("SELECT p.kind, p.status, p.allow_ai_discovery, p.is_private, s.ai_follows_today, s.ai_follows_day FROM profiles p LEFT JOIN profile_scores s ON s.profile_id = p.id WHERE p.id = ?1")
    .bind(targetId)
    .first<{ kind: string; status: string; allow_ai_discovery: number; is_private: number; ai_follows_today: number | null; ai_follows_day: string | null }>();
  if (!t || t.status !== "active" || t.is_private) return false;
  if (t.kind !== "ai" && !t.allow_ai_discovery) return false;
  if (await isBlockedEitherWay(db, agentId, targetId)) return false;
  if (opts.capCheck !== false && t.kind !== "ai") {
    const { growthDailyCap } = await import("../jobs/growth");
    const cap = await growthDailyCap(env, targetId);
    const used = t.ai_follows_day === dayKey() ? (t.ai_follows_today ?? 0) : 0;
    if (used >= cap) return false;
  }
  const now = Date.now();
  const r = await db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, source, created_at) VALUES (?1, ?2, 'ai', ?3)").bind(agentId, targetId, now).run();
  if (!r.meta.changes) return false;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO ai_interactions (id, agent_id, target_profile_id, post_id, kind, dedupe_key, created_at) VALUES (?1, ?2, ?3, NULL, 'follow', ?4, ?5)").bind(newId(now), agentId, targetId, `follow:${agentId}:${targetId}:${now}`, now),
    db.prepare(
      `INSERT INTO profile_scores (profile_id, ai_follows_today, ai_follows_day, updated_at) VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(profile_id) DO UPDATE SET ai_follows_today = CASE WHEN ai_follows_day = ?2 THEN ai_follows_today + 1 ELSE 1 END, ai_follows_day = ?2`,
    ).bind(targetId, dayKey(now), now),
  ]);
  await notify(env, { recipientId: targetId, type: "follow", actorId: agentId });
  await maybeAwardAfterFollow(env, targetId);
  return true;
}

export async function aiUnfollow(env: Env, agentId: string, targetId: string): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM follows WHERE follower_id = ?1 AND followee_id = ?2").bind(agentId, targetId).run();
  if (!r.meta.changes) return false;
  await claim(env.DB, agentId, "unfollow", targetId, null, `unfollow:${agentId}:${targetId}:${Date.now()}`);
  return true;
}

export async function loadPostLite(db: D1Database, postId: string): Promise<PostLite | null> {
  const r = await db
    .prepare(
      `SELECT p.id, p.author_id, a.handle_display, a.display_name, a.kind, p.text, p.topics, p.quality_score, p.created_at, p.reply_to_id, p.root_id, p.thread_depth, p.ai_generated,
              a.visibility, a.allow_ai_replies, a.allow_ai_discovery, a.is_private, a.status, p.deleted_at, p.moderation_status,
              (SELECT group_concat(tag) FROM post_hashtags h WHERE h.post_id = p.id) AS tags,
              (SELECT group_concat(kind) FROM media m WHERE m.post_id = p.id) AS media_kinds
       FROM posts p JOIN profiles a ON a.id = p.author_id WHERE p.id = ?1`,
    )
    .bind(postId)
    .first<Record<string, string | number | null>>();
  // AI accounts only engage with public, live, unmoderated posts.
  if (!r || r.deleted_at || r.moderation_status !== "ok" || r.is_private || r.status !== "active") return null;
  const kinds = r.media_kinds ? String(r.media_kinds).split(",") : [];
  return {
    id: String(r.id),
    authorId: String(r.author_id),
    authorHandle: String(r.handle_display),
    authorName: String(r.display_name),
    authorKind: String(r.kind),
    text: String(r.text ?? ""),
    topics: String(r.topics ?? "").split(",").filter(Boolean),
    hashtags: r.tags ? String(r.tags).split(",") : [],
    mediaCount: kinds.length,
    mediaKinds: kinds,
    quality: Number(r.quality_score),
    createdAt: Number(r.created_at),
    replyToId: r.reply_to_id ? String(r.reply_to_id) : null,
    rootId: String(r.root_id ?? r.id),
    threadDepth: Number(r.thread_depth),
    aiGenerated: !!r.ai_generated,
    authorVisibility: Number(r.visibility),
    authorAllowsAiReplies: !!r.allow_ai_replies,
    authorAllowsAiDiscovery: !!r.allow_ai_discovery,
  };
}

export { getConfig };
