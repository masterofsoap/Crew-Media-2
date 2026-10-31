import { HttpError } from "./http";

/** Verify a Turnstile token when TURNSTILE_SITE_KEY/TURNSTILE_SECRET are configured; no-op otherwise. */
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string) {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET) return;
  if (!token) throw new HttpError(400, "TURNSTILE_REQUIRED", "Please complete the verification check.");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = (await res.json()) as { success: boolean };
  if (!data.success) throw new HttpError(400, "TURNSTILE_FAILED", "Verification failed. Please try again.");
}
