import { defineConfig } from "vitest/config";
import {testExecutionConfig} from './scripts/test-execution-config.mjs';

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    // Explicit bounded parallelism; no test selection or timeout relaxation.
    maxWorkers: testExecutionConfig.workers.longCorrectness,
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: testExecutionConfig.correctnessTimeoutMs,
    hookTimeout: testExecutionConfig.correctnessTimeoutMs,
  },
});
