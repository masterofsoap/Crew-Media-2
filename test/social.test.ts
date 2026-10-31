import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, PNG, uniq } from "./helpers";
import { sweepExpiredMedia, handleMediaJob } from "../src/worker/jobs/media-cleanup";
import { awardMilestones } from "../src/worker/lib/milestones";

async function pair() {
  const a = new Client();
  await a.register(uniq("alice"));
  const b = new Client();
  await b.register(uniq("bob"));
  return { a, b };
}

describe("posts and engagement", () => {
  it("creates posts, likes/unlikes, reposts, quotes, replies, edits with history and deletes", async () => {
    const { a, b } = await pair();
    const p = await a.post("/posts", { text: "Sunday soup recipe experiment with too much garlic #soupseason" });
    expect(p.status).toBe(201);
    const id = p.json.id;
    expect(p.json.text).toContain("#soupseason");

    expect((await b.post(`/posts/${id}/like`)).json.likeCount).toBe(1);
    expect((await b.post(`/posts/${id}/like`)).json.likeCount).toBe(1); // idempotent
    expect((await b.del(`/posts/${id}/like`)).json.likeCount).toBe(0);

    expect((await b.post(`/posts/${id}/repost`)).json.repostCount).toBe(1);
    const q = await b.post("/posts", { text: "This garlic ratio is a bold choice and I support it", quoteOfId: id });
    expect(q.status).toBe(201);
    expect(q.json.quote.id).toBe(id);
    const reply = await b.post("/posts", { text: "What kind of stock did you use for this one?", replyToId: id });
    expect(reply.status).toBe(201);

    const thread = await a.get(`/posts/${id}`);
    expect(thread.json.post.replyCount).toBe(1);
    expect(thread.json.post.quoteCount).toBe(1);
    expect(thread.json.post.repostCount).toBe(1);
    const replies = await a.get(`/posts/${id}/replies`);
    expect(replies.json.items[0].id).toBe(reply.json.id);

    const edited = await a.patch(`/posts/${id}`, { text: "Sunday soup recipe experiment with a reasonable amount of garlic #soupseason" });
    expect(edited.status).toBe(200);
    expect(edited.json.editedAt).toBeTruthy();
    expect((await a.get(`/posts/${id}/revisions`)).json.items).toHaveLength(1);
    expect((await b.patch(`/posts/${id}`, { text: "hijack" })).status).toBe(403);

    expect((await b.del(`/posts/${id}`)).status).toBe(403);
    expect((await a.del(`/posts/${id}`)).status).toBe(200);
    expect((await a.get(`/posts/${id}`)).json.post.deleted).toBe(true);
  });

  it("validates text limits on the server and rejects duplicate spam", async () => {
    const { a } = await pair();
    expect((await a.post("/posts", { text: "x".repeat(501) })).status).toBe(400);
    expect((await a.post("/posts", { text: "   " })).status).toBe(400);
    expect((await a.post("/posts", { text: "The same thoughtful sentence twice." })).status).toBe(201);
    expect((await a.post("/posts", { text: "The same thoughtful sentence twice!" })).json.code).toBe("DUPLICATE");
  });

  it("shows followed posts in the Following feed and indexes hashtags and search", async () => {
    const { a, b } = await pair();
    const tag = uniq("tag").toLowerCase();
    const p = await b.post("/posts", { text: `Trying out a new trail this weekend #${tag}` });
    expect((await a.post(`/follows/${b.profileId}`)).json.state).toBe("following");
    const feed = await a.get("/feed/following");
    expect(feed.json.items.map((i: any) => i.post.id)).toContain(p.json.id);
    const h = await a.get(`/hashtags/${tag}`);
    expect(h.json.items[0].post.id).toBe(p.json.id);
    const s = await a.get(`/search?q=${encodeURIComponent("trail weekend")}&type=posts`);
    expect(s.json.posts.items.map((i: any) => i.post.id)).toContain(p.json.id);
    // Hostile search input is treated as text, never SQL/FTS syntax.
    expect((await a.get(`/search?q=${encodeURIComponent(`"' OR 1=1; DROP TABLE posts; -- NEAR(`)}`)).status).toBe(200);
    const fy = await a.get("/feed/for-you");
    expect(fy.status).toBe(200);
  });

  it("enforces private accounts and blocks", async () => {
    const { a, b } = await pair();
    await b.patch("/profiles/me", { isPrivate: true });
    const secret = await b.post("/posts", { text: "Only for people I approve, thanks" });
    expect((await a.get(`/posts/${secret.json.id}`)).status).toBe(404);
    expect((await a.post(`/follows/${b.profileId}`)).json.state).toBe("requested");
    expect((await b.post(`/follow-requests/${a.profileId}/approve`)).status).toBe(200);
    expect((await a.get(`/posts/${secret.json.id}`)).status).toBe(200);

    expect((await b.post(`/blocks/${a.profileId}`)).status).toBe(200);
    expect((await a.get(`/posts/${secret.json.id}`)).status).toBe(404);
    expect((await a.post(`/follows/${b.profileId}`)).status).toBe(400);
    expect((await a.post("/conversations", { memberIds: [b.profileId] })).status).toBe(403);
  });

  it("notifies on likes (batched) and replies", async () => {
    const { a, b } = await pair();
    const c = new Client();
    await c.register(uniq("carol"));
    const p = await a.post("/posts", { text: "Batch my notifications please, it's a test" });
    await b.post(`/posts/${p.json.id}/like`);
    await c.post(`/posts/${p.json.id}/like`);
    await env.DB.prepare("SELECT 1").first();
    const n = await a.get("/notifications");
    const likes = n.json.items.filter((x: any) => x.type === "like");
    expect(likes).toHaveLength(1);
    expect(likes[0].actorCount).toBe(2);
    expect((await a.get("/notifications/unread")).json.count).toBeGreaterThan(0);
    await a.post("/notifications/read", {});
    expect((await a.get("/notifications/unread")).json.count).toBe(0);
  });
});

describe("direct messages", () => {
  it("delivers messages to members only and supports delete semantics", async () => {
    const { a, b } = await pair();
    await b.patch("/profiles/me", { dmPolicy: "everyone" });
    const conv = await a.post("/conversations", { memberIds: [b.profileId] });
    expect(conv.status).toBe(201);
    const again = await a.post("/conversations", { memberIds: [b.profileId] });
    expect(again.json.id).toBe(conv.json.id); // direct conversations are unique per pair

    const m = await a.post(`/conversations/${conv.json.id}/messages`, { text: "Are we still on for Sunday dinner?" });
    expect(m.status).toBe(201);
    expect((await b.get("/conversations")).json.items[0].unread).toBe(1);
    expect((await b.get(`/conversations/${conv.json.id}/messages`)).json.items[0].text).toContain("Sunday");

    const outsider = new Client();
    await outsider.register(uniq("eve"));
    expect((await outsider.get(`/conversations/${conv.json.id}/messages`)).status).toBe(404);
    expect((await outsider.post(`/conversations/${conv.json.id}/messages`, { text: "let me in" })).status).toBe(404);

    expect((await b.del(`/conversations/${conv.json.id}/messages/${m.json.id}?scope=everyone`)).status).toBe(403);
    expect((await a.del(`/conversations/${conv.json.id}/messages/${m.json.id}?scope=everyone`)).status).toBe(200);
    const after = await b.get(`/conversations/${conv.json.id}/messages`);
    expect(after.json.items[0].deleted).toBe(true);
    expect(after.json.items[0].text).toBeNull();
  });

  it("respects DM policy (following-only by default)", async () => {
    const { a, b } = await pair();
    expect((await a.post("/conversations", { memberIds: [b.profileId] })).status).toBe(403);
    await b.post(`/follows/${a.profileId}`);
    expect((await a.post("/conversations", { memberIds: [b.profileId] })).status).toBe(201);
  });
});

describe("media with 7-day expiry", () => {
  it("validates by content, sets expiry from upload time, serves to authorized viewers, and stops serving after expiry", async () => {
    const { a, b } = await pair();
    const bad = await a.req("POST", "/media?purpose=post", new TextEncoder().encode("<script>alert(1)</script>"), { "Content-Type": "image/png" });
    expect(bad.status).toBe(415);
    const mismatch = await a.req("POST", "/media?purpose=post", PNG, { "Content-Type": "image/jpeg" });
    expect(mismatch.status).toBe(415);

    const before = Date.now();
    const up = await a.req("POST", "/media?purpose=post", PNG, { "Content-Type": "image/png" });
    expect(up.status).toBe(201);
    expect(up.json.expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 3600_000 - 1000);
    expect(up.json.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 24 * 3600_000 + 1000);

    // Unattached media is private to the uploader.
    expect((await b.get(`/media/${up.json.id}`)).status).toBe(404);
    const p = await a.post("/posts", { text: "Look at this tiny pixel", mediaIds: [up.json.id] });
    expect(p.status).toBe(201);
    const served = await b.req("GET", `/media/${up.json.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(served.headers.get("Content-Type")).toBe("image/png");
    // Can't reuse media in another post.
    expect((await a.post("/posts", { text: "again", mediaIds: [up.json.id] })).status).toBe(400);

    // Simulate the passage of 7 days.
    await env.DB.prepare("UPDATE media SET expires_at = ?2 WHERE id = ?1").bind(up.json.id, Date.now() - 1000).run();
    expect((await b.get(`/media/${up.json.id}`)).status).toBe(410); // never served, even before cleanup
    const view = await b.get(`/posts/${p.json.id}`);
    expect(view.json.post.text).toBe("Look at this tiny pixel"); // post survives
    expect(view.json.post.media[0].status).toBe("expired");
    expect(view.json.post.media[0].url).toBeNull();

    // Cleanup pipeline: sweep marks + queues; consumer deletes the R2 object.
    await sweepExpiredMedia(env);
    const row = await env.DB.prepare("SELECT status, r2_key FROM media WHERE id = ?1").bind(up.json.id).first<{ status: string; r2_key: string }>();
    expect(["expiring", "expired"]).toContain(row!.status);
    await handleMediaJob(env, { kind: "media.delete", mediaIds: [up.json.id], key: "t" });
    const done = await env.DB.prepare("SELECT status, removed_at FROM media WHERE id = ?1").bind(up.json.id).first<{ status: string; removed_at: number }>();
    expect(done!.status).toBe("expired");
    expect(await env.MEDIA.head(row!.r2_key)).toBeNull();
  });
});

describe("milestones", () => {
  it("awards milestones idempotently from real follow rows and keeps them if followers drop", async () => {
    const { a } = await pair();
    const target = a.profileId;
    // Create 5,000 real (AI audience) profiles that follow the target.
    const now = Date.now();
    const prefix = uniq("aud");
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO profiles (id, handle, handle_display, display_name, kind, ai_class, avatar_seed, created_at, updated_at)
       SELECT ?1 || i, ?1 || i, ?1 || i, 'Audience ' || i, 'ai', 'audience', 's', ?2, ?2 FROM n`,
    ).bind(prefix, now).run();
    // Cached count alone must not award anything.
    await env.DB.prepare("UPDATE profiles SET follower_count = 999999 WHERE id = ?1").bind(target).run();
    expect(await awardMilestones(env, target)).toEqual([]);
    await env.DB.prepare("UPDATE profiles SET follower_count = 0 WHERE id = ?1").bind(target).run();
    await env.DB.prepare(
      `INSERT INTO follows (follower_id, followee_id, source, created_at) SELECT id, ?1, 'ai', ?2 FROM profiles WHERE handle LIKE ?3`,
    ).bind(target, now, `${prefix}%`).run();
    const count = await env.DB.prepare("SELECT follower_count FROM profiles WHERE id = ?1").bind(target).first<{ follower_count: number }>();
    expect(count!.follower_count).toBe(5000);
    expect(await awardMilestones(env, target)).toEqual([1]);
    expect(await awardMilestones(env, target)).toEqual([]); // idempotent
    await env.DB.prepare("DELETE FROM follows WHERE followee_id = ?1 AND follower_id IN (SELECT id FROM profiles WHERE handle LIKE ?2 LIMIT 100)").bind(target, `${prefix}%`).run();
    const prof = await a.get(`/profiles/${(await a.get("/auth/session")).json.session.profiles[0].handle}`);
    expect(prof.json.followerCount).toBe(4900);
    expect(prof.json.milestones[0].achievedAt).toBeTruthy(); // preserved
    expect(prof.json.milestones[1].achievedAt).toBeNull();
    expect(prof.json.milestoneLevel).toBe(1);
  });
});

describe("AI accounts never post", () => {
  it("blocks top-level posts, quotes and media from AI accounts but allows comments", async () => {
    const { createPost } = await import("../src/worker/routes/posts");
    const human = new Client();
    await human.register(uniq("human"));
    const post = await human.post("/posts", { text: "Anyone have a good weeknight soup recipe?" });
    const ai = await env.DB.prepare("SELECT id FROM profiles WHERE kind = 'ai' AND ai_class = 'persona' LIMIT 1").first<{ id: string }>();
    const aiId = ai?.id ?? (await (async () => {
      await env.DB.prepare("INSERT INTO profiles (id, handle, handle_display, display_name, kind, ai_class, avatar_seed, created_at, updated_at) VALUES ('aitest1','aitest1','aitest1','AI Test','ai','persona','s',1,1)").run();
      return "aitest1";
    })());
    await expect(createPost(env, { authorId: aiId, text: "An original AI post", aiGenerated: true })).rejects.toThrow(/only comment/);
    await expect(createPost(env, { authorId: aiId, text: "A quote", quoteOfId: post.json.id, replyToId: null, aiGenerated: true })).rejects.toThrow(/only comment/);
    const reply = await createPost(env, { authorId: aiId, text: "Try a lemony white bean soup — ten minutes if you use canned beans.", replyToId: post.json.id, aiGenerated: true }, { skipAiEvent: true });
    expect(reply).toBeTruthy();
  });
});
