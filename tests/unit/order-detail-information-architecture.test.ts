import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("order detail information architecture", () => {
  it("keeps the inspection report available but collapsed by default", async () => {
    const report = await readFile("apps/web/src/inspection-report-readonly.tsx", "utf8");
    expect(report).toContain('import "./rework-detail-compact.css"');
    expect(report).toContain('<details className="inspection-readonly"');
    expect(report).toContain('className="inspection-readonly__summary"');
    expect(report).toContain("验货报告");
    expect(report).toContain("inspection-readonly__content");
    expect(report).not.toContain('<details className="inspection-readonly" open');
  });

  it("reduces the primary summary to the five business facts approved for the compact header", async () => {
    const styles = await readFile("apps/web/src/rework-detail-compact.css", "utf8");
    expect(styles).toContain(".rework-detail-summary > .section-title");
    expect(styles).toContain(".rework-detail-summary-section > h3");
    expect(styles).toContain(".rework-detail-facts--issue > div:nth-child(2)");
    expect(styles).toContain(".rework-detail-facts--core > div:nth-child(2)");
    expect(styles).toContain(".rework-detail-facts--core > div:nth-child(3)");
    expect(styles).toContain(".rework-detail-facts--secondary > div:nth-child(3)");
    expect(styles).toContain(".rework-detail-facts--secondary > div:nth-child(4)");
    expect(styles).toContain("grid-template-columns: repeat(5, minmax(0, 1fr));");
    expect(styles).toContain("@media (max-width: 760px)");
  });

  it("derives the visible rework process from the latest N02 configuration without mutating the order", async () => {
    const service = await readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8");
    expect(service).toContain("string_agg(item.process_name,'、' ORDER BY item.position)");
    expect(service).toContain("latest_configuration.process_names");
    expect(service).toContain("to_jsonb(orders)->>'rework_process'");
  });

  it("removes the unused order-number placeholder from desktop and mobile order cards", async () => {
    const card = await readFile("apps/web/src/reporting/management-order-card.tsx", "utf8");
    expect(card).toContain('<small>{order.reworkNo ?? "返工单"}</small>');
    expect(card).not.toContain("订单号未填写");
  });
});
