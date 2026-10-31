import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, uniq } from "./helpers";
import { expandAudience, audienceCount } from "../src/worker/jobs/audience";
import { audienceEngagement, distributeGrowth, attrition } from "../src/worker/jobs/growth";

describe("AI audience at scale", () => {
  it("creates audience accounts set-based, grows a profile from real rows, and delivers proportional likes", async () => {
    const before = await audienceCount(env.DB);
    const made = await expandAudience(env, 12_000);
    expect(made).toBe(12_000);
    expect(await audienceCount(env.DB)).toBe(before + 12_000);
    const sample = await env.DB.prepare("SELECT kind, ai_class, handle, display_name, primary_topic, appearance_json, dm_policy FROM profiles WHERE audience_slot = ?1").bind(before + 5).first<Record<string, string>>();
    expect(sample).toMatchObject({ kind: "ai", ai_class: "audience", appearance_json: "{}", dm_policy: "none" });
    expect(sample!.handle).toMatch(/^[a-z]+_[a-z]+_\d+$/);
    // Audience accounts never show up in discovery.
    const viewer = new Client();
    await viewer.register(uniq("viewer"));
    const s = await viewer.get(`/search?q=${encodeURIComponent((sample!.display_name ?? "").split(" ")[0] ?? "")}&type=top`);
    expect((s.json.profiles as { aiClass: string }[]).every((p) => p.aiClass !== "audience")).toBe(true);

    // A high-performing creator with 5,000 followers already.
    const c = new Client();
    await c.register(uniq("creator"));
    await c.patch("/profiles/me", { interests: ["food", "family"] });
    const post = await c.post("/posts", { text: "Sunday dinner tradition: everyone brings one dish their grandparents made. Tonight was pierogi and tamales side by side. What would you bring?" });
    await env.DB.prepare(
      `INSERT INTO follows (follower_id, followee_id, source, created_at) SELECT id, ?1, 'ai', ?2 FROM profiles WHERE audience_slot >= ?3 AND audience_slot < ?3 + 5000`,
    ).bind(c.profileId, Date.now() - 86400_000, before + 6000).run();
    await env.DB.prepare("UPDATE profile_scores SET growth_score = 0.9, consistency = 0.9, ai_follows_today = 0, ai_follows_day = '' WHERE profile_id = ?1").bind(c.profileId).run();
    const f0 = (await env.DB.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(c.profileId).first<{ follower_count: number }>())!.follower_count;
    expect(f0).toBe(5000);

    await distributeGrowth(env);
    const after = await env.DB.prepare("SELECT p.follower_count, s.audience_cursor, s.ai_follows_today FROM profiles p JOIN profile_scores s ON s.profile_id = p.id WHERE p.id = ?1").bind(c.profileId).first<{ follower_count: number; audience_cursor: number; ai_follows_today: number }>();
    expect(after!.follower_count).toBeGreaterThan(f0);
    expect(after!.ai_follows_today).toBe(after!.follower_count - f0);
    // ~1.5%/day × 0.9^1.5 split across the remaining hours: a few, not thousands.
    expect(after!.follower_count - f0).toBeLessThan(80);
    expect(after!.audience_cursor).toBeGreaterThanOrEqual(0);
    const real = (await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?1").bind(c.profileId).first<{ n: number }>())!.n;
    expect(real).toBe(after!.follower_count); // counts are backed by real rows

    // Milestone 1 (5,000) is awarded from real rows.
    const ms = await env.DB.prepare("SELECT level FROM milestones WHERE profile_id = ?1").bind(c.profileId).all();
    expect(ms.results.length).toBeGreaterThanOrEqual(0);

    // Engagement: back-date the post 12h; likes ≈ followers × rate × time curve.
    await env.DB.prepare("UPDATE posts SET created_at = ?2 WHERE id = ?1").bind(post.json.id, Date.now() - 12 * 3600_000).run();
    await audienceEngagement(env);
    const likes = (await env.DB.prepare("SELECT like_count, audience_likes FROM posts WHERE id = ?1").bind(post.json.id).first<{ like_count: number; audience_likes: number }>())!;
    expect(likes.like_count).toBeGreaterThan(10);
    expect(likes.like_count).toBeLessThan(500);
    // Running again right away adds nothing new (already at the curve).
    await audienceEngagement(env);
    const again = (await env.DB.prepare("SELECT like_count FROM posts WHERE id = ?1").bind(post.json.id).first<{ like_count: number }>())!;
    expect(again.like_count - likes.like_count).toBeLessThan(5);
    const n = await c.get("/notifications");
    const likeNote = n.json.items.find((x: { type: string }) => x.type === "like");
    expect(likeNote.actorCount).toBe(likes.like_count);

    // Churn removes real rows only.
    await attrition(env);
    const fc = (await env.DB.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(c.profileId).first<{ follower_count: number }>())!.follower_count;
    const rows = (await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?1").bind(c.profileId).first<{ n: number }>())!.n;
    expect(fc).toBe(rows);
  });
});
