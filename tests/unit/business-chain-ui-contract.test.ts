import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business-chain UI handoff contracts", () => {
  it("inherits N01 quantity and persists a valid N02 draft before IE submit", async () => {
    const source = await readFile(
      "apps/web/src/process-configuration-form.tsx",
      "utf8",
    );
    expect(source).toContain("/business-detail");
    expect(source).toContain("emptyItem(detail.reworkQuantity)");
    expect(source).toContain("validateItemForms");
    expect(source).toContain("const saved = await persistCurrentDraft()");
    expect(source).toContain("expectedOrderVersion: saved.orderVersion");
    expect(source).toContain(
      "expectedConfigurationVersion: savedConfiguration.configurationVersion",
    );
  });

  it("does not send zero-share N07 responsibility rows", async () => {
    const source = await readFile(
      "apps/web/src/responsibility-determination-panel.tsx",
      "utf8",
    );
    expect(source).toContain("allocation.shareBps > 0n");
    expect(source).toContain("total === 10000n");
  });

  it("keeps process, work and wage nodes inside the shared navigation shell", async () => {
    const [app, shell] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(app).toContain('<Shell active="工序配置"><ProcessConfigurationForm /></Shell>');
    expect(app).toContain('<Shell active="分工上数"><WorkReportingForm /></Shell>');
    expect(app).toContain('<Shell active="工资核对"><WagePage path={path} /></Shell>');
    expect(shell).toContain('["序", "工序配置", "/ui/process-configuration"]');
    expect(shell).toContain('["数", "分工上数", "/ui/work-reporting"]');
    expect(shell).toContain('["薪", "工资核对", "/ui/wages"]');
  });

  it("prevalidates N10-B deduction and unresolved-difference closure inputs", async () => {
    const source = await readFile(
      "apps/web/src/external-responsibility-panel.tsx",
      "utf8",
    );
    expect(source).toContain("请先填写大于 0、最多两位小数的实际扣款金额");
    expect(source).toContain("部分扣款或未扣成功关闭必须先上传扣款结果证据");
    expect(source).toContain("部分扣款或未扣成功关闭必须填写剩余差额最终处理方式");
  });
});
