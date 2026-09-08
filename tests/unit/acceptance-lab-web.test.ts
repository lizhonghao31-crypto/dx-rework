import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("acceptance lab controller UI", () => {
  it("keeps the controller outside business AuthGate without reformatting App or linking production navigation", async () => {
    const [main, app, page, components] = await Promise.all([
      readFile("apps/web/src/main.tsx", "utf8"),
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/acceptance-lab-page.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(main).toContain('import { AcceptanceLabPage } from "./acceptance-lab-page.js"');
    expect(main).toContain('const acceptanceLabPath = `${basePath}/ui/acceptance-lab`');
    expect(main).toContain('? <AcceptanceLabPage />');
    expect(app).not.toContain("acceptance-lab");
    expect(components).not.toContain('href: "/ui/acceptance-lab"');
    expect(page).toContain('acceptance/control/start');
    expect(page).toContain('acceptance/control/switch');
    expect(page).toContain('target="_blank"');
    expect(page).toContain('当前被测身份');
  });
});
