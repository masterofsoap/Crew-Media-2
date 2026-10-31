import type { RealtimeEvent } from "../../shared/types";

/** Fan an event out to every open socket of a profile via its ProfileHub Durable Object. Best-effort. */
export async function pushTo(env: Env, profileIds: string[], event: RealtimeEvent) {
  await Promise.all(
    [...new Set(profileIds)].map(async (pid) => {
      try {
        const stub = env.REALTIME.get(env.REALTIME.idFromName(pid));
        await stub.fetch("https://hub/push", { method: "POST", body: JSON.stringify(event) });
      } catch (e) {
        console.warn(JSON.stringify({ level: "warn", source: "realtime", message: "push failed", error: String(e) }));
      }
    }),
  );
}
