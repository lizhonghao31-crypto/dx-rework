import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("v1 prelaunch business information uniqueness", () => {
  it("uses embedded display modes for every standalone workspace inside order detail", async () => {
    const detail = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(detail).toMatch(/<ProcessConfigurationForm[\s\S]*?reworkOrderId=\{detail\.reworkOrderId\}[\s\S]*?embedded/);
    expect(detail).toMatch(/<WorkReportingForm[\s\S]*?taskMode=\{selected\.key\}[\s\S]*?embedded/);
    expect(detail).toMatch(/<WorkReportingForm[\s\S]*?taskMode="whole_order_review"[\s\S]*?embedded/);
    expect(detail).toContain("<ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId} embedded");
    expect(detail).toContain("readOnly embedded");
    expect(detail).toContain("<ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} readOnly={!moduleWritable} embedded");
  });

  it("keeps standalone heroes while hiding them in embedded mode", async () => {
    const sources = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/legacy-process-configuration-form.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
    ]);
    for (const source of sources) {
      expect(source).toContain("embedded = false");
      expect(source).toMatch(/!embedded(?: && !frontlineContext)? && <div className="mobile-hero"/);
    }
  });

  it("shows the selected node once and keeps completed-node history collapsed by default", async () => {
    const detail = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(detail).toMatch(/<div className="rework-detail-task__heading"><h2>办理区[\s\S]*?<\/h2><span className="rework-detail-single-piece-total">/);
    expect(detail).not.toContain("<h2>当前工作区</h2><p>{selected?.number} · {selected?.label}</p>");
    expect(detail).toContain('<details className="rework-detail-node-history">');
    expect(detail).toContain("<summary>处理历史");
    expect(detail).not.toContain('<details className="rework-detail-node-history" open>');
  });

  it("keeps decision information inside embedded forms", async () => {
    const [process, reporting, responsibility] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
    ]);
    expect(process).toContain("还需完成：{readinessIssues.join");
    expect(reporting).toContain("我已完工&上数");
    expect(responsibility).toContain("责任比例");
  });
});
