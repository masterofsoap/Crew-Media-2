import { SELF } from "cloudflare:test";

/** Minimal cookie-jar client that behaves like the SPA (custom CSRF header + acting profile header). */
export class Client {
  cookie = "";
  profileId = "";
  ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { "X-Crew-Client": "1", "CF-Connecting-IP": this.ip, ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.profileId && !("X-Crew-Profile" in extra)) headers["X-Crew-Profile"] = this.profileId;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      payload = body;
      headers["Content-Length"] = String(body.byteLength);
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const res = await SELF.fetch(`http://crew.test/api${path}`, { method, headers, body: payload });
    const set = res.headers.get("Set-Cookie");
    if (set) {
      const m = /crew_sid=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `crew_sid=${m[1]}` : "";
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
  del = (p: string) => this.req("DELETE", p);

  async register(handle: string, pin = "482915", displayName = handle) {
    const r = await this.post("/auth/register", { displayName, handle, pin });
    if (r.status === 201) this.profileId = r.json.session.activeProfileId;
    return r;
  }
}

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36).slice(-4)}${n++}`;

// 1x1 transparent PNG
export const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
