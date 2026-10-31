import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.worker.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, PIN_PEPPER: "test-pepper", BOOTSTRAP_OWNER_TOKEN: "test-bootstrap-token", TURNSTILE_SECRET: "" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 30_000 },
  };
});
