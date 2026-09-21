import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing PC form and owner approval finish", () => {
  it("stores ordered process facts without removing the legacy search field", async () => {
    const [contract, service, migration, craftMigration] = await Promise.all([
      readFile("packages/contracts/src/sourcing.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/api/migrations/0124_sourcing_ordered_processes.sql", "utf8"),
      readFile("apps/api/migrations/0135_sourcing_case_craft_snapshots.sql", "utf8"),
    ]);
    expect(contract).toContain("MAX_SOURCING_PROCESSES = 20");
    expect(contract).toContain("craftIds: z.array(IdSchema)");
    expect(service).toContain("process_items");
    expect(service).not.toContain("input.processDescription");
    expect(service).toContain("const selectedCrafts");
    expect(service).toContain("JSON.stringify(selectedCrafts)");
    expect(service).toContain("COALESCE(decision_row.crafts,crafts_row.crafts)");
    expect(migration).toContain("ADD COLUMN process_items text[]");
    expect(migration).toContain("sourcing_case.process_description");
    expect(migration).toContain("WHERE sourcing_case.deleted_at IS NULL");
    expect(craftMigration).toContain("craft_name_snapshot");
    expect(craftMigration).not.toContain("INSERT INTO sourcing_case_crafts");
  });

  it("renders an ordered editor and a decision-ready owner summary on desktop", async () => {
    const [page, css] = await Promise.all([
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-workspace.css", "utf8"),
    ]);
    for (const text of [
      "工艺及承包范围",
      "＋ 新增工艺",
      "按合同乙方负责的内容顺序登记",
      "最终审批",
      "生产管理建议由",
      "相对 IE 总额变化",
      "老板逐款审批摘要",
      "查看完整订单资料",
      "批准方案",
      "驳回并退回生产管理",
    ]) expect(page).toContain(text);
    expect(page).toContain("craftIds: crafts.map");
    expect(css).toContain("@media (min-width: 761px)");
    expect(page).toContain("subtractFixedPoint");
    expect(page).toContain('<ResponsiveFactsTable caption="老板逐款审批摘要"');
    expect(page).not.toContain('className="sourcing-owner-mobile-summary"');
    expect(css).toContain(".sourcing-owner-decision__desktop");
    expect(css).not.toMatch(/\.sourcing-owner-decision__desktop\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.sourcing-owner-line-review__row\s*\{\s*grid-template-columns: 1fr/);
    expect(css).toContain(".sourcing-process-editor__list");
  });

  it("raises desktop sidebar descriptions to readable contrast", async () => {
    const navigation = await readFile("apps/web/src/shell-navigation.css", "utf8");
    expect(navigation).toContain(".desktop-navigation .primary-navigation__copy small");
    expect(navigation).toMatch(/\.desktop-navigation \.primary-navigation__copy small \{\s*color: #fff;/);
    expect(navigation).toMatch(/\.primary-navigation__entry \.dx-nav-item\.is-active[\s\S]*color: #fff !important;/);
  });

  it("registers the exact migration checksum", async () => {
    const [migration, manifest] = await Promise.all([
      readFile("apps/api/migrations/0124_sourcing_ordered_processes.sql", "utf8"),
      readFile("apps/api/src/platform/migration-manifest.json", "utf8"),
    ]);
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(JSON.parse(manifest).migrations).toContainEqual({
      version: "0124_sourcing_ordered_processes",
      checksum,
    });
  });
});
