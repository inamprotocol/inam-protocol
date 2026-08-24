import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setupEnv.ts"],
    // worker/ has its own vitest.config.ts using @cloudflare/vitest-plugin —
    // run its tests with `cd worker && npm test`, not from here. .claude/ can
    // contain nested git worktrees (each a full checkout, worker/ included)
    // that would otherwise leak into this glob and fail to resolve
    // Cloudflare-only imports like `cloudflare:workers`.
    exclude: ["**/node_modules/**", "worker/**", ".claude/**"],
  },
});
