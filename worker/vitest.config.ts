import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // The suite hits real bindings (D1/KV/rate-limit) sequentially per file;
    // running test files in parallel workers would make the shared local D1
    // state race against itself between files.
    fileParallelism: false,
  },
});
