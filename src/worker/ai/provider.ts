import { getConfig, type Config } from "../lib/settings";
import { dayKey } from "../lib/ids";
import { opsLog } from "../lib/log";

/**
 * Provider-independent AI layer. Every call:
 *  - goes through a budget gate (daily call + token budgets, emergency pause),
 *  - has a timeout and bounded retries for transient errors,
 *  - is metered into ai_usage (per day/model/task).
 * If AI is unavailable, callers get an AiUnavailable error and skip generative work; the social
 * network itself never depends on these calls.
 */

export type AiTask = "dialogue" | "evaluate" | "moderation";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class AiUnavailable extends Error {
  constructor(public reason: "paused" | "budget" | "error" | "timeout", message: string) {
    super(message);
  }
}

interface Provider {
  chat(model: string, messages: ChatMessage[], opts: { maxTokens: number; temperature: number; signal: AbortSignal }): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

class WorkersAiProvider implements Provider {
  constructor(private ai: Ai) {}
  async chat(model: string, messages: ChatMessage[], opts: { maxTokens: number; temperature: number; signal: AbortSignal }) {
    const run = this.ai.run as unknown as (m: string, input: unknown) => Promise<unknown>;
    const res = (await Promise.race([
      run(model, { messages, max_tokens: opts.maxTokens, temperature: opts.temperature }),
      new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new AiUnavailable("timeout", "AI call timed out")))),
    ])) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } } | string;
    if (typeof res === "string") return { text: res };
    const r = res.response;
    const text = typeof r === "string" ? r : r && typeof r === "object" ? JSON.stringify(r) : "";
    return { text, inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens };
  }
}

class OpenAiCompatibleProvider implements Provider {
  constructor(private baseUrl: string, private apiKey: string) {}
  async chat(model: string, messages: ChatMessage[], opts: { maxTokens: number; temperature: number; signal: AbortSignal }) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens, temperature: opts.temperature }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { text: data.choices?.[0]?.message?.content ?? "", inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens };
  }
}

function provider(env: Env, cfg: Config): Provider {
  if (cfg.ai.provider === "openai-compatible") {
    if (!env.AI_OPENAI_BASE_URL || !env.AI_API_KEY) throw new AiUnavailable("error", "openai-compatible provider is not configured");
    return new OpenAiCompatibleProvider(env.AI_OPENAI_BASE_URL, env.AI_API_KEY);
  }
  return new WorkersAiProvider(env.AI);
}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export async function budgetState(db: D1Database, cfg: Config) {
  const r = await db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage WHERE day = ?1").bind(dayKey()).first<{ calls: number; tokens: number }>();
  const calls = r?.calls ?? 0;
  const tokens = r?.tokens ?? 0;
  return { calls, tokens, ok: calls < cfg.ai.dailyCallBudget && tokens < cfg.ai.dailyTokenBudget, remainingCalls: Math.max(0, cfg.ai.dailyCallBudget - calls) };
}

async function meter(db: D1Database, model: string, task: AiTask, inTok: number, outTok: number, error: boolean) {
  await db
    .prepare(
      `INSERT INTO ai_usage (day, model, task, calls, errors, input_tokens, output_tokens) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
       ON CONFLICT(day, model, task) DO UPDATE SET calls = calls + 1, errors = errors + ?4, input_tokens = input_tokens + ?5, output_tokens = output_tokens + ?6`,
    )
    .bind(dayKey(), model, task, error ? 1 : 0, inTok, outTok)
    .run();
}

export async function chat(env: Env, task: AiTask, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<ChatResult> {
  const cfg = await getConfig(env.DB);
  if (cfg.ai.paused) throw new AiUnavailable("paused", "AI generation is paused");
  const budget = await budgetState(env.DB, cfg);
  if (!budget.ok) throw new AiUnavailable("budget", "Daily AI budget reached");
  const model = cfg.ai.models[task];
  const p = provider(env, cfg);
  const inputEstimate = estimateTokens(messages.map((m) => m.content).join("\n"));
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ai.callTimeoutMs);
    try {
      const r = await p.chat(model, messages, { maxTokens: opts.maxTokens ?? 200, temperature: opts.temperature ?? 0.8, signal: controller.signal });
      clearTimeout(timer);
      const inTok = r.inputTokens ?? inputEstimate;
      const outTok = r.outputTokens ?? estimateTokens(r.text);
      await meter(env.DB, model, task, inTok, outTok, false);
      return { text: r.text.trim(), inputTokens: inTok, outputTokens: outTok, model };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      await meter(env.DB, model, task, inputEstimate, 0, true);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
    }
  }
  await opsLog(env.DB, "error", "ai.provider", "model call failed", { model, task, error: String(lastErr).slice(0, 300) });
  throw new AiUnavailable(lastErr instanceof AiUnavailable ? lastErr.reason : "error", String(lastErr));
}

/** Llama Guard style moderation. Fails closed for AI-generated output: if we can't check it, we don't post it. */
export async function isSafe(env: Env, text: string, cfg: Config): Promise<boolean> {
  if (!cfg.ai.moderateOutputs) return true;
  try {
    const r = await chat(env, "moderation", [{ role: "user", content: text }], { maxTokens: 20, temperature: 0 });
    return /\bsafe\b/i.test(r.text) && !/\bunsafe\b/i.test(r.text);
  } catch {
    return false;
  }
}
