/**
 * Optional Cloudflare Access verification for /api/admin. When ACCESS_TEAM_DOMAIN and ACCESS_AUD
 * are set, every admin request must carry a valid Cf-Access-Jwt-Assertion (RS256) for that audience.
 */
let jwks: { at: number; keys: (JsonWebKey & { kid: string })[] } | null = null;

const b64urlDecode = (s: string) => {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};

export async function verifyAccessJwt(env: Env, token: string | undefined | null): Promise<boolean> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return true; // not configured
  if (!token) return false;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as { kid: string; alg: string };
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { aud: string | string[]; exp: number; iss: string };
  if (header.alg !== "RS256") return false;
  const team = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (payload.iss !== team) return false;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD) || payload.exp * 1000 < Date.now()) return false;
  if (!jwks || Date.now() - jwks.at > 3600_000) {
    const res = await fetch(`${team}/cdn-cgi/access/certs`);
    jwks = { at: Date.now(), keys: ((await res.json()) as { keys: (JsonWebKey & { kid: string })[] }).keys };
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
}
