import { describe, expect, it } from "vitest";
import { THEMES, THEME_IDS, themeCssVars } from "../src/shared/themes";
import { parseAppearance, appearanceSchema, APPEARANCE_PRESETS, defaultAppearance } from "../src/shared/appearance";
import { extractHashtags, extractMentions, tokenize, inferTopics, compactNumber } from "../src/shared/text";
import { MILESTONES, milestoneLevelFor, nextMilestone } from "../src/shared/constants";
import { heuristicQuality, isGenericComment, similarity } from "../src/worker/lib/quality";
import { scoreCandidate, diversify, type Candidate } from "../src/worker/lib/ranking";
import { configSchema, visibilityMultiplier } from "../src/worker/lib/settings";
import { sniff, parseRange } from "../src/worker/lib/media";
import { ftsQuery, likeEscape } from "../src/worker/routes/search";
import { isWeakPin } from "../src/worker/routes/auth";
import { computeGrowthScore, dailyCap, stageOf } from "../src/worker/jobs/growth";
import { cleanOutput, type Agent } from "../src/worker/ai/agent";
import { ARCHETYPES } from "../src/worker/ai/personas";
import { PNG } from "./helpers";

describe("themes", () => {
  it("ships exactly 20 distinct, complete themes", () => {
    expect(THEMES).toHaveLength(20);
    expect(new Set(THEME_IDS).size).toBe(20);
    const signatures = new Set(THEMES.map((t) => `${t.tokens.bg}|${t.tokens.accent}|${t.headingFont}|${t.pattern?.id}`));
    expect(signatures.size).toBe(20);
    for (const t of THEMES) {
      const vars = themeCssVars(t);
      expect(vars["--c-bg"]).toBeTruthy();
      expect(vars["--t-backdrop"]).toContain("gradient");
    }
  });
});

describe("appearance", () => {
  it("validates, defaults, and salvages bad input field-by-field", () => {
    expect(appearanceSchema.safeParse({ colors: { accent: "red; background:url(evil)" } }).success).toBe(false);
    const salvaged = parseAppearance({ themeId: "pixel-arcade", colors: { accent: "javascript:alert(1)" } });
    expect(salvaged.themeId).toBe("pixel-arcade");
    expect(salvaged.colors.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(parseAppearance(null)).toEqual(defaultAppearance());
    for (const p of APPEARANCE_PRESETS) expect(appearanceSchema.safeParse({ ...defaultAppearance(), ...p.value }).success).toBe(true);
    const a = parseAppearance({ sections: { order: ["posts", "posts"], hidden: [] } });
    expect(new Set(a.sections.order).size).toBe(a.sections.order.length);
    expect(a.sections.order).toHaveLength(7);
  });
});

describe("text", () => {
  it("extracts hashtags, mentions and safe tokens", () => {
    expect(extractHashtags("Hi #Soup #soup and #2024 a#b")).toEqual([{ tag: "soup", display: "Soup" }]);
    expect(extractMentions("cc @Ada_1 and email@x.com")).toEqual(["ada_1"]);
    const t = tokenize("see https://example.com/x). #tag @bob <b>bold</b>");
    expect(t.find((x) => x.t === "link")?.v).toBe("https://example.com/x");
    expect(t.some((x) => x.t === "text" && x.v.includes("<b>"))).toBe(true); // stays text, rendered escaped
    expect(inferTopics("Baking bread for the family dinner tonight")).toEqual(expect.arrayContaining(["food", "family"]));
    expect(compactNumber(1234)).toBe("1.2K");
    expect(compactNumber(200_000_000)).toBe("200M");
  });
});

describe("milestones", () => {
  it("uses the exact required thresholds", () => {
    expect(MILESTONES.map((m) => m.threshold)).toEqual([5_000, 10_000, 100_000, 1_000_000, 10_000_000, 50_000_000, 100_000_000, 200_000_000]);
    expect(milestoneLevelFor(4999)).toBe(0);
    expect(milestoneLevelFor(10_000)).toBe(2);
    expect(milestoneLevelFor(250_000_000)).toBe(8);
    expect(nextMilestone(5000)?.threshold).toBe(10_000);
  });
});

describe("quality & ranking", () => {
  it("rewards substance and penalizes spam", () => {
    const base = { mediaCount: 0, hashtagCount: 0, mentionCount: 0, isReply: false, duplicateOfRecent: false, postsLast24h: 1 };
    const good = heuristicQuality({ ...base, text: "Tried a new sourdough method this weekend: longer cold proof, less flour on the counter. The crumb was finally open. Anyone else tried this?" });
    const spam = heuristicQuality({ ...base, text: "BUY NOW BUY NOW BUY NOW #a #b #c #d #e #f #g #h", hashtagCount: 8 });
    const dup = heuristicQuality({ ...base, text: "Tried a new sourdough method this weekend.", duplicateOfRecent: true });
    expect(good).toBeGreaterThan(0.6);
    expect(spam).toBeLessThan(0.3);
    expect(dup).toBeLessThan(good);
    const flood = heuristicQuality({ ...base, text: "Tried a new sourdough method this weekend.", postsLast24h: 30 });
    expect(flood).toBeLessThan(heuristicQuality({ ...base, text: "Tried a new sourdough method this weekend." }));
  });

  it("rejects generic AI comments", () => {
    expect(isGenericComment("Nice post!")).toBe(true);
    expect(isGenericComment("Love this!")).toBe(true);
    expect(isGenericComment("Great content")).toBe(true);
    expect(isGenericComment("Did you proof it overnight in the fridge? That usually opens the crumb.")).toBe(false);
    expect(similarity("the quick brown fox jumps", "the quick brown fox leaps")).toBeGreaterThan(0.5);
  });

  it("maps the visibility slider to a bounded multiplier with 50 as neutral", () => {
    expect(visibilityMultiplier(50)).toBe(1);
    expect(visibilityMultiplier(0)).toBe(0.25);
    expect(visibilityMultiplier(100)).toBe(1.75);
    expect(visibilityMultiplier(500)).toBe(1.75);
  });

  it("ranks relevant, fresh, quality posts higher and diversifies authors", () => {
    const w = configSchema.parse({}).ranking;
    const now = Date.now();
    const mk = (o: Partial<Candidate>): Candidate => ({
      id: Math.random().toString(36), authorId: "a", authorIsAi: false, createdAt: now, quality: 0.6, topics: [], hashtags: [], likeCount: 0, replyCount: 0, repostCount: 0,
      distinctRepliers: 0, authorConsistency: 0.5, authorVisibility: 50, followed: false, interactedWithAuthor: 0, hasMedia: false, ...o,
    });
    const v = { interests: new Map([["food", 1]]) };
    expect(scoreCandidate(mk({ topics: ["food"] }), v, w, now)).toBeGreaterThan(scoreCandidate(mk({ topics: ["sports"] }), v, w, now));
    expect(scoreCandidate(mk({}), v, w, now)).toBeGreaterThan(scoreCandidate(mk({ createdAt: now - 72 * 3600_000 }), v, w, now));
    expect(scoreCandidate(mk({ authorVisibility: 100 }), v, w, now)).toBeGreaterThan(scoreCandidate(mk({ authorVisibility: 0 }), v, w, now));
    // A pile-on of likes on a low-quality post can't beat a substantive, relevant one.
    expect(scoreCandidate(mk({ topics: ["food"], quality: 0.9 }), v, w, now)).toBeGreaterThan(scoreCandidate(mk({ quality: 0.1, likeCount: 5000 }), v, w, now));
    const items = [...Array(10)].map((_, i) => ({ c: mk({ authorId: i < 6 ? "same" : `x${i}`, authorIsAi: i < 6 }), score: 10 - i }));
    const out = diversify(items, 10);
    expect(out.slice(0, 5).filter((x) => x.c.authorId === "same")).toHaveLength(1);
  });
});

describe("growth", () => {
  it("requires sustained quality and applies stage caps", () => {
    expect(stageOf(50)).toBe("new");
    expect(stageOf(5000)).toBe("established");
    const cfg = configSchema.parse({}).growth;
    const strong = computeGrowthScore({ quality: 0.8, consistency: 0.8, engagement: 0.6, retention: 1, spam: 0 });
    const spammy = computeGrowthScore({ quality: 0.8, consistency: 1, engagement: 0.6, retention: 1, spam: 0.8 });
    expect(strong).toBeGreaterThan(0.6);
    expect(spammy).toBeLessThan(cfg.minGrowthScore);
    expect(dailyCap(cfg, 10, spammy, 1, 50)).toBe(0);
    expect(dailyCap(cfg, 10, strong, 0.8, 50)).toBeLessThanOrEqual(cfg.capNewPerDay);
    expect(dailyCap(cfg, 20_000, strong, 0.2, 50)).toBeLessThan(dailyCap(cfg, 20_000, strong, 0.8, 50)); // momentum needs consistency
    expect(dailyCap(cfg, 10, 1, 1, 50)).toBeLessThanOrEqual(cfg.capNewPerDay);
  });
});

describe("security helpers", () => {
  it("sniffs real content types and parses ranges", () => {
    expect(sniff(PNG)?.mime).toBe("image/png");
    expect(sniff(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(parseRange("bytes=0-99", 1000)).toEqual({ offset: 0, length: 100 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ offset: 900, length: 100 });
    expect(parseRange("bytes=2000-", 1000)).toBeNull();
  });

  it("builds inert FTS and LIKE patterns", () => {
    expect(ftsQuery(`soup" OR NEAR(x) *`)).toBe(`"soup"* "or"* "near"*`);
    expect(ftsQuery("!!")).toBeNull();
    expect(likeEscape("50%_off!")).toBe("50!%!_off!!");
  });

  it("flags weak PINs", () => {
    for (const p of ["000000", "123456", "654321", "111111", "123123"]) expect(isWeakPin(p)).toBe(true);
    expect(isWeakPin("482915")).toBe(false);
  });
});

describe("AI persona output hygiene", () => {
  const agent = { handle: "marlowquips", displayName: "Marlow Quip" } as Agent;
  it("cleans and rejects unusable model output", () => {
    expect(cleanOutput("SKIP", agent)).toBeNull();
    expect(cleanOutput('"Marlow Quip: The printer remembers."', agent)).toBe("The printer remembers.");
    expect(cleanOutput("As an AI language model I can't", agent)).toBeNull();
    expect(cleanOutput("x ".repeat(300), agent)!.length).toBeLessThanOrEqual(281);
  });
  it("has diverse archetypes with distinct handles", () => {
    const handles = ARCHETYPES.flatMap((a) => a.variants.map((v) => v.handle));
    expect(new Set(handles).size).toBe(handles.length);
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(12);
  });
});
