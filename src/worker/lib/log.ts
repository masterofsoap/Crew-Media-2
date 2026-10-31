import { newId } from "./ids";

type Level = "info" | "warn" | "error";

/** Structured operational log: console (Workers Logs) + persisted ops_log for the admin UI. Never pass secrets or message bodies. */
export async function opsLog(db: D1Database, level: Level, source: string, message: string, data: Record<string, unknown> = {}) {
  const line = { level, source, message, ...data };
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
  if (level === "info") return;
  try {
    await db
      .prepare("INSERT INTO ops_log (id, level, source, message, data_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(newId(), level, source, message.slice(0, 500), JSON.stringify(data).slice(0, 2000), Date.now())
      .run();
  } catch (e) {
    console.error("ops_log write failed", String(e));
  }
}
