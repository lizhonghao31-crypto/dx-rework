import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("acceptance lab controller UI", () => {
  it("keeps the controller outside business AuthGate without linking production navigation", async () => {
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
    expect(page).toContain('运行全部角色权限矩阵');
    expect(page).toContain('ACCEPTANCE_ROLE_MATRIX');
    expect(page).toContain('evaluateAcceptanceSnapshot');
    expect(page).toContain('evaluateHttpProbe');
  });

  it("records durable sanitized evidence, fresh runtime versions and blocked transport failures", async () => {
    const [page, evidence] = await Promise.all([
      readFile("apps/web/src/acceptance-lab-page.tsx", "utf8"),
      readFile("apps/web/src/acceptance-evidence.ts", "utf8"),
    ]);
    expect(page).toContain('const EVIDENCE_STORAGE_KEY = "dx-acceptance:evidence:v1"');
    expect(page).toContain('jsonRequest<VersionPayload>("version")');
    expect(page).toContain("const attemptVersion = await captureRuntimeVersion()");
    expect(page).toContain("version: attemptVersion");
    expect(page).toContain("version: scenarioDraft.version");
    expect(page).toContain("appendMatrixEvidence");
    expect(page).toContain("appendScenarioEvidence");
    expect(page).toContain("sanitizeAcceptanceEvidenceReport");
    expect(page).toContain('new Blob([JSON.stringify(safeReport, null, 2)]');
    expect(page).toContain("验收证据无法持久保存");
    expect(page).toContain('window.open("about:blank", "_blank")');
    expect(page).toContain('opened.location.href = pageUrl(scenario.route)');
    expect(page).toContain("actualStatus: PREFLIGHT_TRANSPORT_FAILURE_STATUS");
    expect(page).toContain('status: preflightTransportBlocked ? "blocked" : preflightPassed ? scenarioDraft.status : "fail"');
    expect(page).toContain("本次场景只能记录为受阻");
    expect(page).not.toContain("force click");
    expect(evidence).toContain('"pass" | "fail" | "blocked" | "not_run"');
    expect(evidence).toContain("matrixAttempts: [...report.matrixAttempts");
    expect(evidence).toContain("scenarioAttempts: [");
    expect(evidence).toContain("firstFailureForScenario");
    expect(evidence).toContain('path: "todos/mine?page=1"');
    expect(evidence).toContain('path: "receiving/board?page=1"');
    expect(evidence).toContain('path: "frontline/work-tasks?kind=worker"');
  });
});
