import { postgresTestFiles } from "./scripts/test-suite-plan.mjs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    // Keep the canonical PostgreSQL executor identical on local and two-core CI.
    // Vitest's CPU-minus-one default otherwise serializes these isolated suites.
    maxWorkers: process.env.DX_REWORK_TEST_SUITE_KIND === "postgres" ? 2 : undefined,
    include: ["tests/**/*.test.ts"],
    exclude: process.env.DX_REWORK_TEST_SUITE_KIND === "postgres" ? [] : postgresTestFiles(),
    clearMocks: true,
    restoreMocks: true,
  },
});
