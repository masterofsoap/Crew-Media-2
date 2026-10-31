import { app } from "./app";
import { scheduled } from "./jobs/cron";
import { handleAiJob } from "./ai/consumer";
import { handleMediaJob } from "./jobs/media-cleanup";
import { markJob, type AiJob, type MediaJob } from "./jobs/queue";
import { opsLog } from "./lib/log";

export { ProfileHub } from "./realtime/hub";

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduled(controller, env));
  },

  async queue(batch, env) {
    if (batch.queue.endsWith("-dlq")) {
      // Dead letters: record for operators and stop retrying.
      for (const msg of batch.messages) {
        const body = msg.body as { key?: string; kind?: string };
        if (body.key) await markJob(env.DB, body.key, "dead", "exhausted retries");
        await opsLog(env.DB, "error", batch.queue.includes("ai") ? "ai.dlq" : "media.dlq", "job dead-lettered", { kind: body.kind, key: body.key });
        msg.ack();
      }
      return;
    }
    for (const msg of batch.messages) {
      try {
        if (batch.queue === "crew-plus-media") await handleMediaJob(env, msg.body as MediaJob);
        else await handleAiJob(env, msg.body as AiJob);
        msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ level: "error", source: "queue", queue: batch.queue, error: String(e).slice(0, 300) }));
        msg.retry({ delaySeconds: Math.min(600, 30 * 2 ** msg.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env>;
