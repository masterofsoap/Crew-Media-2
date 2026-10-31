import { THEME_IDS } from "../../shared/themes";
import { getConfig, getFlag, setFlag } from "../lib/settings";
import { createProfileStatements } from "../lib/profiles";
import { opsLog } from "../lib/log";
import { ARCHETYPES, AUDIENCE_FIRST, AUDIENCE_LAST, type ActivityLevel, type Archetype } from "./personas";
import { enqueue } from "../jobs/queue";

const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)]!;
const shuffle = <T>(arr: T[]) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
};

/** Kick off seeding once (idempotent; safe to call on every registration). */
export async function ensureSeeded(env: Env) {
  if (await getFlag(env.DB, "ai_seeded")) return;
  await enqueue(env, "ai", { kind: "population.seed", key: "seed:initial" });
}

interface PersonaPlan {
  arch: Archetype;
  name: string;
  handle: string;
  bio: string;
  activity: ActivityLevel;
  quirks: string[];
}

function planPopulation(size: number): PersonaPlan[] {
  const plans: PersonaPlan[] = [];
  const activities: ActivityLevel[] = ["daily", "regular", "regular", "occasional", "occasional", "rare"];
  // First, every hand-written variant; then synthesized variants cycling through archetypes.
  for (const arch of ARCHETYPES) for (const v of arch.variants) plans.push({ arch, name: v.name, handle: v.handle, bio: v.bio, activity: pick(activities), quirks: shuffle([...arch.quirks]).slice(0, 2) });
  let i = 0;
  while (plans.length < size) {
    const arch = ARCHETYPES[i % ARCHETYPES.length]!;
    const first = pick(AUDIENCE_FIRST);
    const last = pick(AUDIENCE_LAST);
    plans.push({
      arch,
      name: `${first} ${last}`,
      handle: `${first}${last}`.toLowerCase().slice(0, 15) + Math.floor(Math.random() * 900 + 100),
      bio: `AI account · ${arch.label.replace(/^The /, "")}. ${arch.interests.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(", ")}.`,
      activity: pick(activities),
      quirks: shuffle([...arch.quirks]).slice(0, 2),
    });
    i++;
  }
  return shuffle(plans).slice(0, size);
}

/**
 * Seed the initial AI population: persona profiles + agent records and interest-based follow
 * relationships between AI accounts. AI accounts never write posts — they only like, follow and
 * comment on what people post. No model calls are made here.
 */
export async function seedPopulation(env: Env) {
  const db = env.DB;
  if (await getFlag(db, "ai_seeded")) return;
  const lock = await db.prepare("INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('ai_seed_lock', ?1, ?1)").bind(Date.now()).run();
  if (!lock.meta.changes) {
    const l = await db.prepare("SELECT updated_at FROM settings WHERE key = 'ai_seed_lock'").first<{ updated_at: number }>();
    if (l && Date.now() - l.updated_at < 10 * 60_000) return; // another worker is seeding
    await db.prepare("UPDATE settings SET updated_at = ?1 WHERE key = 'ai_seed_lock'").bind(Date.now()).run();
  }
  const cfg = await getConfig(db);
  const size = cfg.ai.initialPopulation;
  const plans = planPopulation(size);
  const now = Date.now();
  const created: { id: string; plan: PersonaPlan }[] = [];
  for (const plan of plans) {
    const exists = await db.prepare("SELECT id FROM profiles WHERE handle = ?1").bind(plan.handle).first<{ id: string }>();
    if (exists) {
      created.push({ id: exists.id, plan });
      continue;
    }
    const createdAt = now - (30 + Math.floor(Math.random() * 300)) * 24 * 3600_000; // accounts have history
    const p = createProfileStatements(db, {
      identityId: null, kind: "ai", aiClass: "persona", handle: plan.handle, handleDisplay: plan.handle, displayName: plan.name,
      bio: plan.bio, interests: plan.arch.interests, themeId: pick(THEME_IDS), createdAt,
    });
    const personality = {
      traits: plan.arch.traits, voice: plan.arch.voice, quirks: plan.quirks, dislikes: plan.arch.dislikes,
      summary: `${plan.arch.label}. ${plan.arch.voice}`,
    };
    await db.batch([
      ...p.stmts,
      db.prepare(
        `INSERT INTO ai_agents (profile_id, archetype, personality_json, interests, keywords, activity_level, chattiness, selectivity, next_wake_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        p.id, plan.arch.id, JSON.stringify(personality), plan.arch.interests.join(","), plan.arch.keywords.join(","), plan.activity,
        Math.min(1, Math.max(0, plan.arch.chattiness + (Math.random() - 0.5) * 0.2)), Math.min(1, Math.max(0, plan.arch.selectivity + (Math.random() - 0.5) * 0.2)),
        now + Math.floor(Math.random() * 3 * 3600_000), createdAt,
      ),
    ]);
    created.push({ id: p.id, plan });
  }

  // Follow graph among personas by interest overlap (real follow rows, source = ai).
  const stmts: D1PreparedStatement[] = [];
  for (const a of created) {
    const scored = created
      .filter((b) => b.id !== a.id)
      .map((b) => ({ b, s: b.plan.arch.interests.filter((x) => a.plan.arch.interests.includes(x)).length + Math.random() }))
      .sort((x, y) => y.s - x.s);
    const n = 3 + Math.floor(Math.random() * 6);
    for (const { b } of scored.slice(0, n)) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, source, created_at) VALUES (?1, ?2, 'ai', ?3)").bind(a.id, b.id, now - Math.floor(Math.random() * 20 * 24 * 3600_000)));
    }
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));

  await setFlag(db, "ai_seeded", { at: Date.now(), personas: created.length });
  await opsLog(db, "warn", "ai.seed", "AI population seeded", { personas: created.length });
}

