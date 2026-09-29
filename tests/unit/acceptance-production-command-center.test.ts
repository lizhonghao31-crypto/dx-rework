import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Acceptance production command center preview", () => {
  it("stays outside the production App and production navigation", async () => {
    const [main, app, components, page] = await Promise.all([
      readFile("apps/web/src/main.tsx", "utf8"),
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/acceptance-production-command-center-page.tsx", "utf8"),
    ]);
    expect(main).toContain("acceptanceCommandCenterPath");
    expect(main).toContain("/ui/acceptance/production-command-center");
    expect(main).toContain("<AcceptanceProductionCommandCenterPage />");
    expect(app).not.toContain("acceptance/production-command-center");
    expect(components).not.toContain("acceptance/production-command-center");
    expect(page).toContain('apiUrl("acceptance/control/status")');
    expect(page).toContain("response.status === 200 || response.status === 401");
    expect(page).toContain("正式生产站点不提供此视觉样板");
  });

  it("shares one demo-data source between the live Acceptance page and offline preview", async () => {
    const [page, fixture, demo] = await Promise.all([
      readFile("apps/web/src/acceptance-production-command-center-page.tsx", "utf8"),
      readFile("tests/fixtures/production-command-center-preview.tsx", "utf8"),
      readFile("apps/web/src/production-command-center-demo-data.ts", "utf8"),
    ]);
    for (const name of [
      "PRODUCTION_COMMAND_CENTER_DEMO_SUMMARY",
      "PRODUCTION_COMMAND_CENTER_DEMO_ORDERS",
      "PRODUCTION_COMMAND_CENTER_DEMO_SELECTED",
    ]) {
      expect(page).toContain(name);
      expect(fixture).toContain(name);
      expect(demo).toContain(name);
    }
  });

  it("captures the live deployed desktop and mobile command-center component", async () => {
    const regression = await readFile("scripts/acceptance/live-browser-regression.mjs", "utf8");
    expect(regression).toContain("ui/acceptance/production-command-center");
    expect(regression).toContain("05-production-command-center-desktop-1536x960.png");
    expect(regression).toContain("06-production-command-center-mobile-390x844.png");
    expect(regression).toContain(".production-command-shell");
    expect(regression).toContain("setViewportSize");
  });
});
