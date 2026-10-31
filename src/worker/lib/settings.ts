import { z } from "zod";

/**
 * Platform configuration stored in D1 (`settings` table, key "config"), merged over defaults.
 * Admins edit it through /api/admin/settings; every change is audited.
 */

export const configSchema = z.object({
  ai: z.object({
    paused: z.boolean().default(false),
    provider: z.enum(["workers-ai", "openai-compatible"]).default("workers-ai"),
    models: z.object({
      dialogue: z.string().min(1).max(120).default("@cf/meta/llama-3.1-8b-instruct-fast"),
      evaluate: z.string().min(1).max(120).default("@cf/meta/llama-3.2-3b-instruct"),
      moderation: z.string().min(1).max(120).default("@cf/meta/llama-guard-3-8b"),
    }).default({}),
    initialPopulation: z.number().int().min(0).max(500).default(48),
    maxActivePersonas: z.number().int().min(0).max(5000).default(200),
    intensity: z.number().min(0.1).max(3).default(1),
    agentsPerTick: z.number().int().min(0).max(100).default(10),
    maxRepliesPerHour: z.number().int().min(0).max(2000).default(30),
    maxLikesPerHour: z.number().int().min(0).max(20000).default(400),
    perAgentDailyActions: z.number().int().min(0).max(500).default(40),
    perAgentDailyGenerations: z.number().int().min(0).max(100).default(6),
    perHumanDailyAiReplies: z.number().int().min(0).max(100).default(6),
    perPostMaxAiReplies: z.number().int().min(0).max(20).default(3),
    perPostMaxAiLikes: z.number().int().min(0).max(500).default(40),
    maxThreadAiTurns: z.number().int().min(0).max(20).default(4),
    perConversationDailyAiMessages: z.number().int().min(0).max(500).default(30),
    dailyCallBudget: z.number().int().min(0).max(1_000_000).default(1500),
    dailyTokenBudget: z.number().int().min(0).max(100_000_000).default(1_500_000),
    callTimeoutMs: z.number().int().min(1000).max(60_000).default(20_000),
    moderateOutputs: z.boolean().default(true),
    evaluateHumanPosts: z.boolean().default(true),
  }).default({}),
  ranking: z.object({
    relevance: z.number().min(0).max(1).default(0.25),
    originality: z.number().min(0).max(1).default(0.2),
    engagement: z.number().min(0).max(1).default(0.15),
    consistency: z.number().min(0).max(1).default(0.15),
    affinity: z.number().min(0).max(1).default(0.1),
    freshness: z.number().min(0).max(1).default(0.1),
    conversation: z.number().min(0).max(1).default(0.05),
    freshnessHalfLifeHours: z.number().min(1).max(168).default(18),
  }).default({}),
  growth: z.object({
    enabled: z.boolean().default(true),
    minGrowthScore: z.number().min(0).max(1).default(0.3),
    /** Flat daily allowance for brand-new profiles (< 100 followers). */
    newPerDay: z.number().int().min(0).max(10_000).default(6),
    /** Daily growth as a fraction of current followers, by stage, before score scaling. */
    risingRate: z.number().min(0).max(0.2).default(0.02), // 100 – 5k
    establishedRate: z.number().min(0).max(0.2).default(0.015), // 5k – 100k
    starRate: z.number().min(0).max(0.2).default(0.01), // 100k – 1M
    megaRate: z.number().min(0).max(0.2).default(0.002), // > 1M
    /** Max AI-sourced followers a single profile can accumulate. */
    aiFollowerCeiling: z.number().int().min(0).max(200_000_000).default(1_000_000),
    /** Upper bound for the audience pool; it only grows as real growth needs it. */
    audienceTarget: z.number().int().min(0).max(5_000_000).default(1_100_000),
    /** Audience likes per post ≈ followers × (base + quality² × bonus), delivered over ~2 days. */
    likeRateBase: z.number().min(0).max(0.5).default(0.004),
    likeRateQualityBonus: z.number().min(0).max(0.5).default(0.03),
  }).default({}),
  limits: z.object({
    postsPerHour: z.number().int().min(1).max(500).default(30),
    messagesPerMinute: z.number().int().min(1).max(500).default(30),
    followsPerHour: z.number().int().min(1).max(2000).default(120),
    uploadsPerHour: z.number().int().min(1).max(1000).default(40),
    editWindowMinutes: z.number().int().min(0).max(1440).default(60),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;

let cached: { at: number; value: Config } | null = null;
const TTL = 15_000;

export async function getConfig(db: D1Database, fresh = false): Promise<Config> {
  if (!fresh && cached && Date.now() - cached.at < TTL) return cached.value;
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = 'config'").first<{ value_json: string }>();
  let raw: unknown = {};
  try {
    raw = row ? JSON.parse(row.value_json) : {};
  } catch {
    raw = {};
  }
  const parsed = configSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : configSchema.parse({});
  cached = { at: Date.now(), value };
  return value;
}

export async function saveConfig(db: D1Database, value: Config, by: string) {
  await db
    .prepare("INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES ('config', ?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
    .bind(JSON.stringify(value), Date.now(), by)
    .run();
  cached = { at: Date.now(), value };
}

export async function getFlag(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value_json FROM settings WHERE key = ?1").bind(key).first<{ value_json: string }>();
  return r ? r.value_json : null;
}

export async function setFlag(db: D1Database, key: string, value: unknown, by = "system") {
  await db
    .prepare("INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
    .bind(key, JSON.stringify(value), Date.now(), by)
    .run();
}

/** Visibility slider (0-100, default 50) → bounded discovery multiplier in [0.25, 1.75]. 50 → 1.0. */
export function visibilityMultiplier(v: number): number {
  const clamped = Math.min(100, Math.max(0, Math.round(v)));
  return 0.25 + 1.5 * (clamped / 100);
}
