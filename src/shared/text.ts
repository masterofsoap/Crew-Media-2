import { HANDLE_RE, TOPICS } from "./constants";

export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, "").toLowerCase();
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h.trim().replace(/^@/, ""));
}

const HASHTAG_RE = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{1,50})/gu;
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([A-Za-z0-9_]{3,20})/gu;

export function extractHashtags(text: string): { tag: string; display: string }[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(HASHTAG_RE)) {
    const display = m[2]!;
    if (/^\d+$/.test(display)) continue;
    const tag = display.toLowerCase();
    if (!out.has(tag)) out.set(tag, display);
  }
  return [...out].slice(0, 10).map(([tag, display]) => ({ tag, display }));
}

export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[2]!.toLowerCase());
  return [...out].slice(0, 10);
}

export type RichToken =
  | { t: "text"; v: string }
  | { t: "hashtag"; v: string }
  | { t: "mention"; v: string }
  | { t: "link"; v: string };

const TOKEN_RE = /(https?:\/\/[^\s<>"']+)|(#[\p{L}\p{N}_]{1,50})|(@[A-Za-z0-9_]{3,20})/gu;

/** Tokenize post text for safe rendering (React escapes every token; nothing becomes HTML). */
export function tokenize(text: string): RichToken[] {
  const tokens: RichToken[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const prev = idx > 0 ? text[idx - 1]! : "";
    if ((m[2] || m[3]) && prev && /[\p{L}\p{N}_&@#]/u.test(prev)) continue;
    if (idx > last) tokens.push({ t: "text", v: text.slice(last, idx) });
    if (m[1]) {
      let url = m[1];
      const trail = url.match(/[.,!?;:)]+$/);
      if (trail) url = url.slice(0, -trail[0].length);
      tokens.push({ t: "link", v: url });
      last = idx + url.length;
      continue;
    }
    if (m[2]) tokens.push({ t: "hashtag", v: m[2].slice(1) });
    else if (m[3]) tokens.push({ t: "mention", v: m[3].slice(1) });
    last = idx + m[0].length;
  }
  if (last < text.length) tokens.push({ t: "text", v: text.slice(last) });
  return tokens;
}

/** Infer topic slugs from free text and hashtags by keyword matching. */
export function inferTopics(text: string, max = 3): string[] {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}#\s-]/gu, " ")} `;
  const scored: { slug: string; score: number }[] = [];
  for (const topic of TOPICS) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (lower.includes(` ${kw} `) || lower.includes(`#${kw.replace(/\s+/g, "")}`)) score += kw.includes(" ") ? 2 : 1;
    }
    if (lower.includes(`#${topic.slug}`)) score += 2;
    if (score > 0) scored.push({ slug: topic.slug, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.slug);
}

export function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function clampText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  const units = [
    { v: 1e9, s: "B" },
    { v: 1e6, s: "M" },
    { v: 1e3, s: "K" },
  ];
  for (const u of units) {
    if (n >= u.v) {
      const x = n / u.v;
      return `${x >= 100 ? Math.floor(x) : Math.floor(x * 10) / 10}${u.s}`;
    }
  }
  return String(n);
}
