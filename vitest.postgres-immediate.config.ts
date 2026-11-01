import {defineConfig} from "vitest/config";
import {testExecutionConfig} from './scripts/test-execution-config.mjs';
// Immediate deletion plus an absence assertion must not overlap other workers' DDL.
export default defineConfig({test:{environment:"node",env:{DATABASE_URL:""},include:["tests/**/*.test.ts"],maxWorkers:testExecutionConfig.workers.postgres,clearMocks:true,restoreMocks:true,testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs}});
