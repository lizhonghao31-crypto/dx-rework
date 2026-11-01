import { postgresTestFiles } from "./scripts/test-suite-plan.mjs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    include: ["tests/**/*.test.ts"],
    exclude: process.env.DX_REWORK_TEST_SUITE_KIND === "postgres" ? [] : postgresTestFiles(),
    clearMocks: true,
    restoreMocks: true,
  },
});
