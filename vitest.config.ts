import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests talk to hosted Supabase; an escalation is a dozen sequential round trips.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
  },
});
