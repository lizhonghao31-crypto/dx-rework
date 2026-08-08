import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow queue navigation", () => {
  it("does not send delegated N07 handlers or external payables to pages they may not be allowed to open", async () => {
    const [responsibility, external] = await Promise.all([
      readFile("apps/web/src/responsibility-queue-page.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-queue-page.tsx", "utf8"),
    ]);
    expect(responsibility).not.toContain('actionHref="/ui/tasks"');
    expect(external).not.toContain('actionHref="/ui/responsibility"');
  });
});
