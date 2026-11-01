import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    // Explicit bounded parallelism; no test selection or timeout relaxation.
    maxWorkers: 2,
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
