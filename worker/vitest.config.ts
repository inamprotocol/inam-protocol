import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Test-only OPERATOR_DID (SPEC.md §12.3), injected here rather than
      // added to wrangler.jsonc's committed `vars` -- that file is also
      // what's deployed to the live api.inamprotocol.org, and a placeholder
      // operator identity there (with a private key nobody controls, or
      // worse, one visible in source) would be a real production
      // authorization hole if a deployment ever went out without replacing
      // it. This override applies only inside this test runner. The
      // corresponding private key lives in tests/testOperator.ts (32 bytes
      // of 0x02, a fixed fixture -- not a real credential).
      miniflare: { bindings: { OPERATOR_DID: "did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH" } },
    }),
  ],
  test: {
    // The suite hits real bindings (D1/KV/rate-limit) sequentially per file;
    // running test files in parallel workers would make the shared local D1
    // state race against itself between files.
    fileParallelism: false,
  },
});
