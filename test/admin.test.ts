import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, uniq } from "./helpers";

describe("administration", () => {
  it("hides admin APIs from non-admins and bootstraps the owner only with the deployment token", async () => {
    const c = new Client();
    await c.register(uniq("boss"), "730196");
    expect((await c.get("/admin/dashboard")).status).toBe(404);
    expect((await c.post("/admin/bootstrap", { token: "wrong-token-123", passphrase: "correct horse battery", pin: "730196" })).status).toBe(403);
    await env.DB.prepare("DELETE FROM admin_roles").run();
    const ok = await c.post("/admin/bootstrap", { token: "test-bootstrap-token", passphrase: "correct horse battery", pin: "730196" });
    expect(ok.status).toBe(200);
    expect((await c.get("/admin/dashboard")).status).toBe(200);

    // A second bootstrap is refused.
    const d = new Client();
    await d.register(uniq("usurper"), "730196");
    expect((await d.post("/admin/bootstrap", { token: "test-bootstrap-token", passphrase: "correct horse battery", pin: "730196" })).status).toBe(409);
  });

  it("requires step-up elevation for mutations, audits changes, and bounds the visibility slider", async () => {
    await env.DB.prepare("DELETE FROM admin_roles").run();
    const owner = new Client();
    await owner.register(uniq("own"), "730196");
    await owner.post("/admin/bootstrap", { token: "test-bootstrap-token", passphrase: "correct horse battery", pin: "730196" });
    const target = new Client();
    await target.register(uniq("tgt"));

    // New profiles default to 50.
    const acct = await owner.get(`/admin/accounts/${target.profileId}`);
    expect(acct.json.profile.visibility).toBe(50);

    // Drop elevation to test the step-up requirement.
    await env.DB.prepare("UPDATE sessions SET elevated_until = 0").run();
    const denied = await owner.patch(`/admin/accounts/${target.profileId}/visibility`, { value: 80 });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("ELEVATION_REQUIRED");
    expect((await owner.post("/admin/elevate", { passphrase: "wrong passphrase!!" })).status).toBe(401);
    expect((await owner.post("/admin/elevate", { passphrase: "correct horse battery" })).status).toBe(200);
    expect((await owner.patch(`/admin/accounts/${target.profileId}/visibility`, { value: 101 })).status).toBe(400);
    expect((await owner.patch(`/admin/accounts/${target.profileId}/visibility`, { value: 80 })).json.visibility).toBe(80);
    const audit = await owner.get("/admin/audit");
    expect(audit.json.items.some((x: any) => x.action === "set_visibility" && x.target_id === target.profileId)).toBe(true);

    // Users can't set their own visibility.
    expect((await target.patch("/profiles/me", { visibility: 100 })).status).toBe(400);
  });

  it("grants and revokes roles with the right permissions", async () => {
    await env.DB.prepare("DELETE FROM admin_roles").run();
    const owner = new Client();
    await owner.register(uniq("own"), "730196");
    await owner.post("/admin/bootstrap", { token: "test-bootstrap-token", passphrase: "correct horse battery", pin: "730196" });
    const modHandle = uniq("mod");
    const mod = new Client();
    await mod.register(modHandle, "730196");
    expect((await owner.post("/admin/admins", { handle: modHandle, role: "moderator" })).status).toBe(200);
    expect((await mod.get("/admin/dashboard")).status).toBe(200);
    // Moderators can't change settings even if elevated.
    await mod.post("/admin/passphrase", { pin: "730196", passphrase: "moderator passphrase" });
    await mod.post("/admin/elevate", { passphrase: "moderator passphrase" });
    expect((await mod.post("/admin/ai/pause")).status).toBe(403);
    const list = await owner.get("/admin/admins");
    const modEntry = list.json.items.find((x: any) => x.role === "moderator");
    expect((await owner.del(`/admin/admins/${modEntry.identityId}`)).status).toBe(200);
    expect((await mod.get("/admin/dashboard")).status).toBe(404);
  });

  it("pauses and resumes AI generation", async () => {
    await env.DB.prepare("DELETE FROM admin_roles").run();
    const owner = new Client();
    await owner.register(uniq("own"), "730196");
    await owner.post("/admin/bootstrap", { token: "test-bootstrap-token", passphrase: "correct horse battery", pin: "730196" });
    expect((await owner.post("/admin/ai/pause")).json.paused).toBe(true);
    expect((await owner.get("/admin/settings")).json.config.ai.paused).toBe(true);
    expect((await owner.post("/admin/ai/resume")).json.paused).toBe(false);
  });
});
