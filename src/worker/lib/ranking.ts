import { visibilityMultiplier, type Config } from "./settings";

/**
 * For You ranking. All signals are precomputed (post quality, author scores, topic tags), so the
 * request path does arithmetic only — no model calls during feed requests.
 */

export interface Candidate {
  id: string;
  authorId: string;
  authorIsAi: boolean;
  createdAt: number;
  quality: number; // 0..1
  topics: string[];
  hashtags: string[];
  likeCount: number;
  replyCount: number;
  repostCount: number;
  distinctRepliers: number;
  authorConsistency: number; // 0..1
  authorVisibility: number; // 0..100
  followed: boolean;
  interactedWithAuthor: number; // viewer's recent likes/replies to this author
  hasMedia: boolean;
}

export interface ViewerSignals {
  interests: Map<string, number>; // topic/hashtag → weight 0..1
}

export type RankWeights = Config["ranking"];

export function scoreCandidate(c: Candidate, v: ViewerSignals, w: RankWeights, now: number): number {
  // Relevance: overlap between post topics/hashtags and the viewer's interest profile.
  let rel = 0;
  for (const t of c.topics) rel = Math.max(rel, v.interests.get(t) ?? 0);
  for (const h of c.hashtags) rel = Math.max(rel, (v.interests.get(`#${h}`) ?? 0) * 0.9);
  if (c.followed) rel = Math.max(rel, 0.6);

  const originality = c.quality;

  // Meaningful engagement: replies (distinct people) count more than likes; log-scaled so raw
  // reaction volume (e.g. a pile-on) cannot dominate.
  const engagementRaw = Math.log1p(c.likeCount + 2 * c.repostCount + 3 * c.distinctRepliers) / Math.log1p(200);
  const engagement = Math.min(1, engagementRaw);

  const consistency = c.authorConsistency;
  const affinity = Math.min(1, (c.followed ? 0.5 : 0) + Math.min(0.5, c.interactedWithAuthor * 0.1));
  const ageHours = Math.max(0, (now - c.createdAt) / 3_600_000);
  const freshness = Math.pow(0.5, ageHours / w.freshnessHalfLifeHours);
  // Conversation quality: thoughtful threads with several distinct participants.
  const conversation = Math.min(1, c.distinctRepliers / 5) * (0.5 + 0.5 * c.quality);

  const base =
    w.relevance * rel +
    w.originality * originality +
    w.engagement * engagement +
    w.consistency * consistency +
    w.affinity * affinity +
    w.freshness * freshness +
    w.conversation * conversation;

  return base * visibilityMultiplier(c.authorVisibility);
}

/**
 * Greedy diversified selection: within each window of `window` items, repeated authors are
 * progressively penalized, each AI author appears at most once, and media posts are interleaved.
 */
export function diversify<T extends { c: Candidate; score: number }>(scored: T[], limit: number, window = 20): T[] {
  const pool = [...scored].sort((a, b) => b.score - a.score);
  const out: T[] = [];
  const authorCount = new Map<string, number>();
  const aiAuthorsUsed = new Set<string>();
  while (pool.length && out.length < limit) {
    if (out.length > 0 && out.length % window === 0) {
      authorCount.clear();
      aiAuthorsUsed.clear();
    }
    let bestIdx = -1;
    let best = -Infinity;
    const lastWasMedia = out.length > 0 && out[out.length - 1]!.c.hasMedia;
    for (let i = 0; i < Math.min(pool.length, 60); i++) {
      const it = pool[i]!;
      if (it.c.authorIsAi && aiAuthorsUsed.has(it.c.authorId)) continue;
      const n = authorCount.get(it.c.authorId) ?? 0;
      let s = it.score * Math.pow(0.55, n);
      if (lastWasMedia && it.c.hasMedia) s *= 0.9;
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const [picked] = pool.splice(bestIdx, 1);
    out.push(picked!);
    authorCount.set(picked!.c.authorId, (authorCount.get(picked!.c.authorId) ?? 0) + 1);
    if (picked!.c.authorIsAi) aiAuthorsUsed.add(picked!.c.authorId);
  }
  return out;
}
