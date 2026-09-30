import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
