import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("acceptance lab controller UI", () => {
  it("keeps the controller outside business AuthGate while leaving it unlinked from production navigation", async () => {
    const [app, page, components] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/acceptance-lab-page.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(app).toContain('path === "/ui/acceptance-lab"');
    expect(app).toContain('return <AcceptanceLabPage />');
    expect(app).toContain('|| path === "/ui/acceptance-lab"');
    expect(components).not.toContain('href: "/ui/acceptance-lab"');
    expect(page).toContain('acceptance/control/start');
    expect(page).toContain('acceptance/control/switch');
    expect(page).toContain('target="_blank"');
    expect(page).toContain('当前被测身份');
  });
});
