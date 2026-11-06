import {defineConfig} from "vitest/config";
import {testExecutionConfig} from './scripts/test-execution-config.mjs';
// Isolate immediate deletion and the SQL-heavy full business fixture from other workers.
// The historical filename remains stable; assertions and shared correctness allowance stay explicit.
export default defineConfig({test:{environment:"node",env:{DATABASE_URL:""},include:["tests/**/*.test.ts"],maxWorkers:testExecutionConfig.workers.postgres,clearMocks:true,restoreMocks:true,testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs}});
