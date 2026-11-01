import { postgresTestFiles } from "./scripts/test-suite-plan.mjs";
import {testExecutionConfig} from './scripts/test-execution-config.mjs';
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    // Ordinary PG regressions keep their original strict timing and run alone.
    // Bounded concurrency belongs to the separately configured long chains.
    maxWorkers: process.env.DX_REWORK_TEST_SUITE_KIND === "postgres" ? testExecutionConfig.workers.postgres : testExecutionConfig.workers.nonDatabase,
    include: ["tests/**/*.test.ts"],
    exclude: process.env.DX_REWORK_TEST_SUITE_KIND === "postgres" ? [] : postgresTestFiles(),
    clearMocks: true,
    restoreMocks: true,
  },
});
