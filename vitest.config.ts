import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setupEnv.ts"],
    // worker/ has its own vitest.config.ts using @cloudflare/vitest-plugin —
    // run its tests with `cd worker && npm test`, not from here.
    exclude: ["**/node_modules/**", "worker/**"],
  },
});
