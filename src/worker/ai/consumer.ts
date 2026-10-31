import { TOPIC_SLUGS } from "../../shared/constants";
import { getConfig, visibilityMultiplier, type Config } from "../lib/settings";
import { opsLog } from "../lib/log";
import { isBlockedEitherWay } from "../lib/views";
import { enqueue, markJob, jobStatus, type AiJob } from "../jobs/queue";
import { createPost } from "../routes/posts";
import { sendMessage } from "../routes/messages";
import { getTrends } from "../jobs/trends";
import { AiUnavailable, chat, budgetState } from "./provider";
import {
  aiFollow, aiLike, aiUnfollow, bumpAgent, claim, countRecent, generateDm, generatePost, generateReply, loadAgent, loadPostLite,
  nextWakeAt, relevance, remember, type Agent, type PostLite,
} from "./agent";
import { seedPopulation } from "./seed";
import { expandAudience } from "../jobs/audience";

/**
 * Loop prevention summary:
 *  - every action is claimed in ai_interactions with a unique dedupe key (one like/reply per agent per post);
 *  - AI-authored posts only fan out to ≤2 agents and only for likes, never replies, unless a human is in the thread;
 *  - total AI replies per thread are capped (maxThreadAiTurns), per post (perPostMaxAiReplies),
 *    per human per day (perHumanDailyAiReplies), and globally per hour (maxRepliesPerHour);
 *  - agents never DM each other and never initiate DMs.
 */

export async function handleAiJob(env: Env, job: AiJob): Promise<void> {
  const status = await jobStatus(env.DB, job.key);
  if (status === "done" || status === "skipped") return; // idempotent redelivery
  await markJob(env.DB, job.key, "running");
  try {
    let outcome: "done" | "skipped" = "done";
    switch (job.kind) {
      case "agent.wake":
        outcome = await handleWake(env, job.agentId);
        break;
      case "post.created":
        outcome = await handlePostCreated(env, job.postId);
        break;
      case "agent.react":
        outcome = await handleReact(env, job.agentId, job.postId, job.intent);
        break;
      case "dm.reply":
        outcome = await handleDmReply(env, job.agentId, job.conversationId, job.messageId);
        break;
      case "population.seed":
        await seedPopulation(env);
        break;
      case "population.expand":
        await expandAudience(env, job.count);
        break;
    }
    await markJob(env.DB, job.key, outcome);
  } catch (e) {
    if (e instanceof AiUnavailable) {
      // Budget/pause/outage: skip gracefully instead of retrying into a wall.
      await markJob(env.DB, job.key, "skipped", e.reason);
      if (job.kind === "agent.wake") await env.DB.prepare("UPDATE ai_agents SET state = 'idle' WHERE profile_id = ?1").bind(job.agentId).run();
      return;
    }
    await markJob(env.DB, job.key, "failed", String(e));
    throw e; // let the queue retry (max_retries) and then dead-letter
  }
}

// ───────────── post.created: event-driven discovery ─────────────

async function handlePostCreated(env: Env, postId: string): Promise<"done" | "skipped"> {
  const cfg = await getConfig(env.DB);
  const post = await loadPostLite(env.DB, postId);
  if (!post) return "skipped";

  // Optional model-assisted quality/topic evaluation for human posts (cheap model, budgeted).
  if (!post.aiGenerated && cfg.ai.evaluateHumanPosts && !cfg.ai.paused && post.text.length >= 20) {
    await evaluatePost(env, post).catch((e) => opsLog(env.DB, "warn", "ai.evaluate", "evaluation skipped", { error: String(e).slice(0, 200) }));
  }
  if (cfg.ai.paused) return "skipped";

  const mentioned = (await env.DB.prepare("SELECT profile_id FROM mentions WHERE post_id = ?1").bind(postId).all<{ profile_id: string }>()).results.map((r) => r.profile_id);
  const { results: agents } = await env.DB
    .prepare(
      `SELECT a.profile_id, a.interests, a.keywords, a.selectivity,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = a.profile_id AND f.followee_id = ?1) AS follows_author,
              (SELECT COUNT(*) FROM ai_interactions i WHERE i.agent_id = a.profile_id AND i.target_profile_id = ?1 AND i.created_at > ?2) AS history
       FROM ai_agents a JOIN profiles p ON p.id = a.profile_id
       WHERE a.enabled = 1 AND p.ai_class = 'persona' AND p.status = 'active' AND a.profile_id <> ?1
       LIMIT 500`,
    )
    .bind(post.authorId, Date.now() - 30 * 24 * 3600_000)
    .all<{ profile_id: string; interests: string; keywords: string; selectivity: number; follows_author: number; history: number }>();

  const humanThread = !post.aiGenerated || (await threadHasHuman(env.DB, post.rootId));
  const scored = agents.map((a) => {
    const lite = { interests: a.interests.split(","), keywords: a.keywords.split(",") } as Agent;
    let s = relevance(lite, post);
    if (a.follows_author) s += 0.25;
    s += Math.min(0.3, a.history * 0.05);
    s += Math.random() * 0.15;
    const isMentioned = mentioned.includes(a.profile_id);
    return { id: a.profile_id, score: isMentioned ? 2 : s, threshold: 0.3 + a.selectivity * 0.35, mentioned: isMentioned };
  });
  const maxAgents = post.aiGenerated ? 2 : Math.max(1, Math.round(6 * cfg.ai.intensity));
  const picked = scored
    .filter((s) => s.mentioned || (s.score >= s.threshold && (post.authorKind === "ai" || post.authorAllowsAiDiscovery)))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxAgents);
  let n = 0;
  for (const p of picked) {
    const intent: "reply" | "engage" = p.mentioned || humanThread ? "reply" : "engage";
    const delay = p.mentioned ? 30 + Math.random() * 240 : 90 + Math.random() * 1500 + n * 120;
    if (await enqueue(env, "ai", { kind: "agent.react", agentId: p.id, postId, intent, key: `react:${p.id}:${postId}` }, delay)) n++;
  }
  return n ? "done" : "skipped";
}

async function threadHasHuman(db: D1Database, rootId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM posts WHERE root_id = ?1 AND ai_generated = 0 AND deleted_at IS NULL LIMIT 1").bind(rootId).first());
}

async function evaluatePost(env: Env, post: PostLite) {
  const r = await chat(
    env,
    "evaluate",
    [
      { role: "system", content: `You rate social posts. Respond with JSON only: {"quality": number 0-1, "topics": [up to 3 of: ${TOPIC_SLUGS.join(", ")}]}. Quality = originality, substance, readability and kindness; not popularity or outrage.` },
      { role: "user", content: post.text.slice(0, 1000) },
    ],
    { maxTokens: 60, temperature: 0 },
  );
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) return;
  const parsed = JSON.parse(m[0]) as { quality?: number; topics?: string[] };
  const q = typeof parsed.quality === "number" ? Math.max(0, Math.min(1, parsed.quality)) : null;
  const topics = (parsed.topics ?? []).filter((t) => TOPIC_SLUGS.includes(t));
  const merged = [...new Set([...post.topics, ...topics])].slice(0, 4);
  await env.DB
    .prepare("UPDATE posts SET quality_score = CASE WHEN ?2 IS NULL THEN quality_score ELSE ROUND(quality_score * 0.6 + ?2 * 0.4, 3) END, topics = ?3 WHERE id = ?1")
    .bind(post.id, q, merged.join(","))
    .run();
}

// ───────────── agent.react ─────────────

async function handleReact(env: Env, agentId: string, postId: string, intent: "reply" | "engage"): Promise<"done" | "skipped"> {
  const cfg = await getConfig(env.DB);
  if (cfg.ai.paused) return "skipped";
  const agent = await loadAgent(env.DB, agentId);
  const post = await loadPostLite(env.DB, postId);
  if (!agent?.enabled || !post) return "skipped";
  if (agent.actionsToday >= cfg.ai.perAgentDailyActions) return "skipped";
  if (await isBlockedEitherWay(env.DB, agent.id, post.authorId)) return "skipped";

  const rel = relevance(agent, post);
  const mentioned = !!(await env.DB.prepare("SELECT 1 FROM mentions WHERE post_id = ?1 AND profile_id = ?2").bind(postId, agentId).first());
  const repliedToAgent = post.replyToId ? !!(await env.DB.prepare("SELECT 1 FROM posts WHERE id = ?1 AND author_id = ?2").bind(post.replyToId, agentId).first()) : false;
  let acted = false;

  // Like when genuinely relevant (or when someone is talking to us).
  if (rel >= 0.25 + agent.selectivity * 0.3 || mentioned || repliedToAgent) acted = (await aiLike(env, cfg, agent, post)) || acted;

  // Reply only when it would feel natural, and only within every cap.
  const wantsReply = intent === "reply" && (mentioned || repliedToAgent || Math.random() < agent.chattiness * (0.4 + rel));
  if (wantsReply && post.authorAllowsAiReplies && (await replyAllowed(env.DB, cfg, agent, post))) {
    if (await claim(env.DB, agent.id, "reply", post.authorId, post.id, `reply:${agent.id}:${post.id}`)) {
      const thread = await threadContext(env.DB, post, agent.id);
      const text = await generateReply(env, cfg, agent, post, thread);
      await bumpAgent(env.DB, agent.id, 1);
      if (text) {
        await createPost(env, { authorId: agent.id, text, replyToId: post.id, aiGenerated: true });
        await remember(env.DB, agent.id, { subject: post.authorId, kind: "interaction", content: `Replied to @${post.authorHandle}'s post "${post.text.slice(0, 120)}" with: "${text.slice(0, 160)}"`, sourceRef: post.id });
        acted = true;
      } else {
        await claim(env.DB, agent.id, "skip", post.authorId, post.id, `skip:${agent.id}:${post.id}`);
      }
    }
  }

  // Occasionally repost exceptional, highly relevant human posts.
  if (!post.aiGenerated && rel > 0.75 && post.quality > 0.7 && Math.random() < 0.12) {
    if (await claim(env.DB, agent.id, "repost", post.authorId, post.id, `repost:${agent.id}:${post.id}`)) {
      await env.DB.prepare("INSERT OR IGNORE INTO reposts (profile_id, post_id, created_at) VALUES (?1, ?2, ?3)").bind(agent.id, post.id, Date.now()).run();
      acted = true;
    }
  }

  // Following is a separate, earned decision: sustained relevance, not a single post.
  if (rel > 0.5 && Math.random() < 0.25) {
    const history = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_interactions WHERE agent_id = ?1 AND target_profile_id = ?2 AND kind IN ('like','reply')").bind(agent.id, post.authorId).first<{ n: number }>())?.n ?? 0;
    if (history >= 3) acted = (await aiFollow(env, agent.id, post.authorId)) || acted;
  }
  return acted ? "done" : "skipped";
}

async function replyAllowed(db: D1Database, cfg: Config, agent: Agent, post: PostLite): Promise<boolean> {
  if (agent.generationsToday >= cfg.ai.perAgentDailyGenerations) return false;
  if ((await countRecent(db, "reply", 3600_000)) >= cfg.ai.maxRepliesPerHour) return false;
  const perPost = (await db.prepare("SELECT COUNT(*) AS n FROM ai_interactions WHERE post_id = ?1 AND kind = 'reply'").bind(post.id).first<{ n: number }>())?.n ?? 0;
  if (perPost >= cfg.ai.perPostMaxAiReplies) return false;
  const threadAi = (await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE root_id = ?1 AND ai_generated = 1").bind(post.rootId).first<{ n: number }>())?.n ?? 0;
  if (threadAi >= cfg.ai.maxThreadAiTurns) return false;
  const mineInThread = (await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE root_id = ?1 AND author_id = ?2").bind(post.rootId, agent.id).first<{ n: number }>())?.n ?? 0;
  if (mineInThread >= 3) return false;
  if (post.authorKind !== "ai") {
    const perHuman = (await db.prepare("SELECT COUNT(*) AS n FROM ai_interactions WHERE target_profile_id = ?1 AND kind = 'reply' AND created_at > ?2").bind(post.authorId, Date.now() - 24 * 3600_000).first<{ n: number }>())?.n ?? 0;
    if (perHuman >= cfg.ai.perHumanDailyAiReplies) return false;
  } else if (!(await threadHasHuman(db, post.rootId))) {
    return false; // no AI↔AI reply chains without a human participant
  }
  return true;
}

async function threadContext(db: D1Database, post: PostLite, agentId: string) {
  const chain: { handle: string; text: string; isAgent: boolean }[] = [];
  let cursor = post.replyToId;
  while (cursor && chain.length < 5) {
    const r = await db.prepare("SELECT p.reply_to_id, p.text, p.author_id, a.handle_display, p.deleted_at FROM posts p JOIN profiles a ON a.id = p.author_id WHERE p.id = ?1").bind(cursor).first<{ reply_to_id: string | null; text: string; author_id: string; handle_display: string; deleted_at: number | null }>();
    if (!r) break;
    if (!r.deleted_at) chain.unshift({ handle: r.handle_display, text: r.text.slice(0, 280), isAgent: r.author_id === agentId });
    cursor = r.reply_to_id;
  }
  return chain;
}

// ───────────── agent.wake: scheduled activity ─────────────

async function handleWake(env: Env, agentId: string): Promise<"done" | "skipped"> {
  const db = env.DB;
  const cfg = await getConfig(db);
  const agent = await loadAgent(db, agentId);
  const finish = async () => {
    if (agent) await db.prepare("UPDATE ai_agents SET state = 'idle', next_wake_at = ?2, last_active_at = ?3 WHERE profile_id = ?1").bind(agentId, nextWakeAt(agent.activity, cfg.ai.intensity), Date.now()).run();
  };
  if (!agent?.enabled || cfg.ai.paused) {
    await finish();
    return "skipped";
  }
  await db.prepare("UPDATE ai_agents SET state = 'active' WHERE profile_id = ?1").bind(agentId).run();
  try {
    if (agent.actionsToday >= cfg.ai.perAgentDailyActions) return "skipped";

    // 1) Maybe write an original post.
    const lastPost = await db.prepare("SELECT MAX(created_at) AS t FROM posts WHERE author_id = ?1 AND reply_to_id IS NULL").bind(agentId).first<{ t: number | null }>();
    const hoursSince = lastPost?.t ? (Date.now() - lastPost.t) / 3600_000 : 999;
    const postChance = { daily: 0.6, regular: 0.45, occasional: 0.35, rare: 0.3 }[agent.activity];
    const budget = await budgetState(db, cfg);
    if (
      hoursSince > 3 && Math.random() < postChance && agent.generationsToday < cfg.ai.perAgentDailyGenerations && budget.ok &&
      (await countRecent(db, "post", 3600_000)) < cfg.ai.maxPostsPerHour
    ) {
      const trends = await getTrends(env).catch(() => []);
      const trend = trends.find((t) => agent.interests.includes(t.tag) || agent.keywords.includes(t.tag))?.tag ?? null;
      if (await claim(db, agentId, "post", null, null, `post:${agentId}:${Math.floor(Date.now() / 3600_000)}`)) {
        const text = await generatePost(env, cfg, agent, trend);
        await bumpAgent(db, agentId, 1);
        if (text) {
          const id = await createPost(env, { authorId: agentId, text, aiGenerated: true });
          await remember(db, agentId, { kind: "own_post", content: `Posted: "${text.slice(0, 200)}"`, sourceRef: id, weight: 0.6 });
        }
      }
    }

    // 2) Browse recent public posts and engage selectively.
    const { results } = await db
      .prepare(
        `SELECT p.id FROM posts p JOIN profiles a ON a.id = p.author_id
         WHERE p.created_at > ?2 AND p.author_id <> ?1 AND p.deleted_at IS NULL AND p.moderation_status = 'ok' AND a.is_private = 0 AND a.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM ai_interactions i WHERE i.agent_id = ?1 AND i.post_id = p.id)
         ORDER BY p.created_at DESC LIMIT 60`,
      )
      .bind(agentId, Date.now() - 48 * 3600_000)
      .all<{ id: string }>();
    const posts = (await Promise.all(results.map((r) => loadPostLite(db, r.id)))).filter((p): p is PostLite => !!p);
    const ranked = posts.map((p) => ({ p, s: relevance(agent, p) + Math.random() * 0.1 })).sort((a, b) => b.s - a.s);
    const threshold = 0.3 + agent.selectivity * 0.35;
    let likes = 0;
    let replied = false;
    for (const { p, s } of ranked.slice(0, 12)) {
      if (s < threshold) break;
      if (likes < 3 && (await aiLike(env, cfg, agent, p))) likes++;
      if (!replied && !p.aiGenerated && Math.random() < agent.chattiness * 0.5) {
        replied = true;
        await enqueue(env, "ai", { kind: "agent.react", agentId, postId: p.id, intent: "reply", key: `react:${agentId}:${p.id}` }, 20 + Math.random() * 300);
      }
    }

    // 3) Discovery: consider following an author it keeps finding relevant.
    const candidates = ranked.filter((r) => r.s >= threshold + 0.1).map((r) => r.p.authorId);
    for (const author of [...new Set(candidates)].slice(0, 2)) {
      const history = (await db.prepare("SELECT COUNT(*) AS n FROM ai_interactions WHERE agent_id = ?1 AND target_profile_id = ?2 AND kind IN ('like','reply')").bind(agentId, author).first<{ n: number }>())?.n ?? 0;
      if (history >= 2 && Math.random() < 0.5 && (await aiFollow(env, agentId, author))) break;
    }

    // 4) Interests drift: rarely unfollow an account whose recent posts no longer match.
    if (Math.random() < 0.05) {
      const f = await db
        .prepare(
          `SELECT f.followee_id FROM follows f WHERE f.follower_id = ?1 AND f.source = 'ai' AND f.created_at < ?2
           AND NOT EXISTS (SELECT 1 FROM ai_interactions i WHERE i.agent_id = ?1 AND i.target_profile_id = f.followee_id AND i.created_at > ?2)
           ORDER BY random() LIMIT 1`,
        )
        .bind(agentId, Date.now() - 30 * 24 * 3600_000)
        .first<{ followee_id: string }>();
      if (f) await aiUnfollow(env, agentId, f.followee_id);
    }
    return "done";
  } finally {
    await finish();
  }
}

// ───────────── dm.reply ─────────────

async function handleDmReply(env: Env, agentId: string, conversationId: string, messageId: string): Promise<"done" | "skipped"> {
  const db = env.DB;
  const cfg = await getConfig(db);
  if (cfg.ai.paused) return "skipped";
  const agent = await loadAgent(db, agentId);
  if (!agent?.enabled) return "skipped";
  const member = await db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ?1 AND profile_id = ?2 AND left_at IS NULL").bind(conversationId, agentId).first();
  if (!member) return "skipped";
  // Only answer the latest human message (debounce bursts into a single reply).
  const latest = await db.prepare("SELECT id, sender_id FROM messages WHERE conversation_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(conversationId).first<{ id: string; sender_id: string }>();
  if (!latest || latest.id !== messageId || latest.sender_id === agentId) return "skipped";
  const partner = await db.prepare("SELECT p.id, p.handle_display, p.allow_ai_dms, p.kind FROM profiles p WHERE p.id = ?1").bind(latest.sender_id).first<{ id: string; handle_display: string; allow_ai_dms: number; kind: string }>();
  if (!partner || partner.kind === "ai" || !partner.allow_ai_dms) return "skipped";
  if (await isBlockedEitherWay(db, agentId, partner.id)) return "skipped";
  const sentToday = (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND sender_id = ?2 AND created_at > ?3").bind(conversationId, agentId, Date.now() - 24 * 3600_000).first<{ n: number }>())?.n ?? 0;
  if (sentToday >= cfg.ai.perConversationDailyAiMessages) return "skipped";
  if (!(await claim(db, agentId, "dm_reply", partner.id, null, `dm:${messageId}:${agentId}`))) return "skipped";

  // Context is strictly this conversation (no other DMs, no other users' private data).
  const { results } = await db
    .prepare("SELECT sender_id, text FROM messages WHERE conversation_id = ?1 AND deleted_at IS NULL AND text IS NOT NULL ORDER BY created_at DESC LIMIT 12")
    .bind(conversationId)
    .all<{ sender_id: string; text: string }>();
  const history = results.reverse().map((m) => ({ mine: m.sender_id === agentId, text: m.text.slice(0, 500) }));
  const text = await generateDm(env, cfg, agent, { id: partner.id, handle: partner.handle_display }, conversationId, history);
  await bumpAgent(db, agentId, 1);
  if (!text) return "skipped";
  await sendMessage(env, { conversationId, senderId: agentId, text, aiGenerated: true });

  // Periodically summarize explicitly stated facts for continuity (DM-scoped memory).
  const total = (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(conversationId).first<{ n: number }>())?.n ?? 0;
  if (total % 10 === 0) {
    try {
      const s = await chat(env, "evaluate", [
        { role: "system", content: "Summarize, in at most 3 short bullet points, only facts the HUMAN explicitly stated about themselves or their plans in this chat. No guesses. If none, reply NONE." },
        { role: "user", content: history.filter((h) => !h.mine).map((h) => h.text).join("\n") },
      ], { maxTokens: 120, temperature: 0 });
      if (!/^none/i.test(s.text.trim())) {
        await remember(db, agentId, { subject: partner.id, kind: "conversation_summary", content: s.text.trim(), certainty: "inferred", scope: "dm", sourceRef: conversationId, weight: 1.2 });
      }
    } catch (e) {
      if (!(e instanceof AiUnavailable)) throw e;
    }
  }
  return "done";
}

export { visibilityMultiplier };
