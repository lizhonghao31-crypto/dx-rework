import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { DATABASE_URL: "" },
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
