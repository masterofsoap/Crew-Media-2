import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, uniq } from "./helpers";

describe("authentication & profiles", () => {
  it("registers with name, handle and PIN and never stores the PIN in plaintext", async () => {
    const c = new Client();
    const handle = uniq("ada");
    const r = await c.register(handle, "482915", "Ada");
    expect(r.status).toBe(201);
    expect(r.json.recoveryCode).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    expect(r.json.session.profiles[0].handle).toBe(handle);
    const row = await env.DB.prepare("SELECT i.* FROM identities i WHERE i.id = ?1").bind(r.json.session.identityId).first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("482915");
    expect(row!.pin_iterations).toBe(100000);
    expect(String(row!.pin_hash).length).toBeGreaterThan(20);
    // Session API never exposes hashes.
    const s = await c.get("/auth/session");
    expect(JSON.stringify(s.json)).not.toMatch(/pin_hash|pin_salt|recovery_hash/);
  });

  it("rejects duplicate handles case-insensitively, invalid handles and weak PINs", async () => {
    const handle = uniq("Dup");
    expect((await new Client().register(handle)).status).toBe(201);
    expect((await new Client().register(handle.toLowerCase())).status).toBe(409);
    expect((await new Client().register("a!")).status).toBe(400);
    const weak = await new Client().register(uniq("weak"), "123456");
    expect(weak.status).toBe(400);
    expect(weak.json.code).toBe("WEAK_PIN");
    expect((await new Client().register(uniq("short"), "1234")).status).toBe(400);
  });

  it("rate-limits and locks out repeated wrong PINs without revealing which part was wrong", async () => {
    const owner = new Client();
    const handle = uniq("lock");
    await owner.register(handle, "730196");
    const attacker = new Client();
    const unknown = await attacker.post("/auth/login", { handle: uniq("nobody"), pin: "000000" });
    const wrong = await attacker.post("/auth/login", { handle, pin: "000000" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.json.error).toBe(wrong.json.error); // no enumeration
    let status = 0;
    for (let i = 0; i < 6; i++) status = (await attacker.post("/auth/login", { handle, pin: "000000" })).status;
    expect(status).toBe(429);
    // Even the right PIN is refused while locked.
    expect((await attacker.post("/auth/login", { handle, pin: "730196" })).status).toBe(429);
  });

  it("logs in with the correct PIN", async () => {
    const handle = uniq("login");
    await new Client().register(handle, "730196");
    const c = new Client();
    const r = await c.post("/auth/login", { handle, pin: "730196" });
    expect(r.status).toBe(200);
    expect(c.cookie).toContain("crew_sid=");
    expect((await c.get("/auth/session")).json.session.profiles).toHaveLength(1);
  });

  it("supports multiple profiles with instant switching and blocks stale-tab posting", async () => {
    const c = new Client();
    await c.register(uniq("multi"));
    const first = c.profileId;
    const r = await c.post("/profiles", { displayName: "Gaming Me", handle: uniq("gamer") });
    expect(r.status).toBe(201);
    const second = r.json.profileId;
    expect(r.json.session.activeProfileId).toBe(second);
    expect(r.json.session.profiles).toHaveLength(2);

    // A stale tab still believing it acts as `first` must be rejected.
    const stale = await c.req("POST", "/posts", { text: "hello from the wrong profile" }, { "X-Crew-Profile": first });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("PROFILE_MISMATCH");

    c.profileId = second;
    const ok = await c.post("/posts", { text: "posting as my gaming profile #gaming" });
    expect(ok.status).toBe(201);
    expect(ok.json.author.id).toBe(second);

    const sw = await c.post("/auth/switch", { profileId: first });
    expect(sw.status).toBe(200);
    expect(sw.json.session.activeProfileId).toBe(first);
  });

  it("rejects switching to or acting as a profile you don't own", async () => {
    const a = new Client();
    await a.register(uniq("own"));
    const b = new Client();
    await b.register(uniq("other"));
    expect((await a.post("/auth/switch", { profileId: b.profileId })).status).toBe(403);
    // Forging the header doesn't help either: the session's active profile is authoritative.
    const forged = await a.req("POST", "/posts", { text: "impersonation attempt" }, { "X-Crew-Profile": b.profileId });
    expect(forged.status).toBe(409);
  });

  it("rejects protected fields (mass assignment) on profile updates", async () => {
    const c = new Client();
    await c.register(uniq("mass"));
    for (const field of [{ visibility: 100 }, { follower_count: 5000 }, { kind: "ai" }, { adminRole: "owner" }]) {
      expect((await c.patch("/profiles/me", field)).status).toBe(400);
    }
    expect((await c.patch("/profiles/me", { bio: "Hello there" })).status).toBe(200);
  });

  it("recovers an account only with the recovery code, rotating the code and revoking sessions", async () => {
    const c = new Client();
    const handle = uniq("rec");
    const reg = await c.register(handle, "730196");
    const code = reg.json.recoveryCode as string;
    const thief = new Client();
    expect((await thief.post("/auth/recover", { handle, code: "AAAAA-BBBBB-CCCCC-DDDDD", newPin: "905172" })).status).toBe(401);
    const r = await thief.post("/auth/recover", { handle, code, newPin: "905172" });
    expect(r.status).toBe(200);
    expect(r.json.recoveryCode).not.toBe(code);
    // The original session was revoked.
    expect((await c.get("/auth/session")).json.session).toBeNull();
    // Old code no longer works; new PIN does.
    expect((await new Client().post("/auth/recover", { handle, code, newPin: "613408" })).status).toBe(401);
    expect((await new Client().post("/auth/login", { handle, pin: "905172" })).status).toBe(200);
  });

  it("requires the CSRF client header on mutations", async () => {
    const c = new Client();
    await c.register(uniq("csrf"));
    const r = await c.req("POST", "/posts", { text: "x" }, { "X-Crew-Client": "0" });
    expect(r.status).toBe(403);
  });
});

describe("4-digit PINs", () => {
  it("accepts a non-guessable 4-digit PIN, rejects common ones and anything shorter", async () => {
    const handle = uniq("four");
    expect((await new Client().register(handle, "4827")).status).toBe(201);
    expect((await new Client().post("/auth/login", { handle, pin: "4827" })).status).toBe(200);
    expect((await new Client().register(uniq("fourw"), "1990")).json.code).toBe("WEAK_PIN");
    expect((await new Client().register(uniq("three"), "482")).status).toBe(400);
  });
});
