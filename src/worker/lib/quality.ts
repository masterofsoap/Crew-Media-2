/**
 * Deterministic post-quality heuristic (0..1). Runs on every post at write time with no model
 * call. When enabled, the AI evaluator later blends in a model judgment (see ai/evaluate.ts).
 */
export interface QualityInput {
  text: string;
  mediaCount: number;
  hashtagCount: number;
  mentionCount: number;
  isReply: boolean;
  duplicateOfRecent: boolean;
  postsLast24h: number;
}

export function heuristicQuality(q: QualityInput): number {
  const text = q.text.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const unique = new Set(words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).size;
  let score = 0.35;

  // Substance: reward a reasonable amount of original text, with a soft plateau.
  if (wordCount >= 4) score += 0.1;
  if (wordCount >= 12) score += 0.12;
  if (wordCount >= 30) score += 0.08;
  if (q.mediaCount > 0) score += wordCount >= 3 ? 0.1 : 0.05;

  // Variety of vocabulary (penalize "lol lol lol lol").
  if (wordCount >= 4) {
    const ratio = unique / wordCount;
    if (ratio < 0.4) score -= 0.25;
    else if (ratio > 0.7) score += 0.05;
  }

  // Readability: sentence structure present, not shouting.
  if (/[.!?]/.test(text) && wordCount >= 8) score += 0.05;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length > 12 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) score -= 0.2;
  const freq = new Map<string, number>();
  for (const w of words) {
    const k = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (k.length > 2) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  if (wordCount < 30 && [...freq.values()].some((n) => n >= 3)) score -= 0.15;
  if (/(.)\1{6,}/.test(text)) score -= 0.15;

  // Spam signals.
  if (q.hashtagCount > 5) score -= 0.08 * (q.hashtagCount - 5);
  if (q.mentionCount > 5) score -= 0.08 * (q.mentionCount - 5);
  const linkCount = (text.match(/https?:\/\//g) ?? []).length;
  if (linkCount > 0 && wordCount - linkCount < 3) score -= 0.15;
  if (q.duplicateOfRecent) score -= 0.4;
  if (/^(nice|great|cool|wow|lol|love (it|this)|awesome|amazing)[.!]*$/i.test(text)) score -= 0.2;

  // Diminishing returns for flooding.
  if (q.postsLast24h > 10) score -= Math.min(0.3, (q.postsLast24h - 10) * 0.02);

  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

/** Simple token-set Jaccard similarity used to avoid repetitive AI output and duplicate posts. */
export function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const tb = new Set(b.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const GENERIC = [
  /^(so )?(nice|great|cool|awesome|amazing|beautiful|lovely|wonderful)( (post|content|pic|photo|shot|share|one))?[.!]*$/i,
  /^love (this|it|that)[.!]*$/i,
  /^(this is )?(so )?(true|real)[.!]*$/i,
  /^(thanks|thank you) for sharing[.!]*$/i,
  /^(well said|so true|agreed|same)[.!]*$/i,
];

/** True when a generated comment adds nothing and should be discarded. */
export function isGenericComment(text: string): boolean {
  const t = text.trim().replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
  if (t.length < 12) return true;
  return GENERIC.some((re) => re.test(t));
}
