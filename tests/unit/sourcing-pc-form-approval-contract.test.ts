import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing PC form and owner approval finish", () => {
  it("stores ordered process facts without removing the legacy search field", async () => {
    const [contract, service, migration] = await Promise.all([
      readFile("packages/contracts/src/sourcing.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/api/migrations/0124_sourcing_ordered_processes.sql", "utf8"),
    ]);
    expect(contract).toContain("MAX_SOURCING_PROCESSES = 20");
    expect(contract).toContain("processes: z.array(SourcingProcessSchema)");
    expect(service).toContain("process_items");
    expect(service).toContain("processDescription: processes.join(\"、\")");
    expect(migration).toContain("ADD COLUMN process_items text[]");
    expect(migration).toContain("sourcing_case.process_description");
    expect(migration).toContain("WHERE sourcing_case.deleted_at IS NULL");
  });

  it("renders an ordered editor and a decision-ready owner summary on desktop", async () => {
    const [page, css] = await Promise.all([
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-workspace.css", "utf8"),
    ]);
    for (const text of [
      "工艺清单",
      "＋ 新增工艺",
      "按实际生产顺序登记",
      "老板审批摘要",
      "拟选加工厂",
      "价格变化",
      "选厂 / 调价说明",
    ]) expect(page).toContain(text);
    expect(page).toContain("processes: normalizedProcesses");
    expect(css).toContain("@media (min-width: 761px)");
    expect(css).toContain(".sourcing-owner-summary");
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
