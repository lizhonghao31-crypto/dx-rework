import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { WaiveTailInspectionSchema } from "@dx-rework/contracts";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("existing-order tail inspection waiver", () => {
  it("requires optimistic concurrency and a non-empty audited reason", () => {
    expect(WaiveTailInspectionSchema.parse({
      expectedVersion: 7,
      reason: "工序实际无需尾查",
    })).toEqual({ expectedVersion: 7, reason: "工序实际无需尾查" });
    expect(WaiveTailInspectionSchema.safeParse({ expectedVersion: 7, reason: "   " }).success).toBe(false);
  });

  it("grants only owner and production management while retaining Root override in the route", async () => {
    const [migration, routes] = await Promise.all([
      read("apps/api/migrations/0105_existing_order_tail_inspection_waiver.sql"),
      read("apps/api/src/rework/routes.ts"),
    ]);
    expect(migration).toContain("('owner_group','tail_inspection:waive')");
    expect(migration).toContain("('production_management','tail_inspection:waive')");
    expect(migration).not.toContain("('tail_supervisor','tail_inspection:waive')");
    expect(routes).toContain('role === "owner_group" || role === "production_management"');
    expect(routes).toContain('actorRoles.push("root_superuser")');
  });

  it("invalidates existing tail reports and retires both unified and legacy tail work", async () => {
    const [service, migration] = await Promise.all([
      read("apps/api/src/rework/service.ts"),
      read("apps/api/migrations/0105_existing_order_tail_inspection_waiver.sql"),
    ]);
    expect(service).toContain("INSERT INTO rework_work_report_rejections");
    expect(service).toContain("item.execution_kind='tail_inspection'");
    expect(service).toContain("UPDATE rework_tail_inspection_reports");
    expect(service).toContain("UPDATE rework_tail_inspection_assignments");
    expect(service).toContain("tail_inspection_required=false");
    expect(migration).toContain("guard_rework_work_report_rejection_insert");
    expect(migration).toContain("guard_rework_tail_inspection_report_rejection");
    expect(migration).toContain("guard_rework_tail_inspection_assignment_revoke");
  });

  it("keeps waived tail configuration out of completion readiness and explains settlement exclusion in UI", async () => {
    const [reporting, page] = await Promise.all([
      read("apps/api/src/rework/work-reporting-service.ts"),
      read("apps/web/src/rework-detail-page.tsx"),
    ]);
    expect(reporting).toContain("item.execution_kind='worker' OR target.tail_inspection_required");
    expect(page).toContain("不再计入最终数量、工资和责任");
    expect(page).toContain('hasRole(currentUser, "owner_group") || hasRole(currentUser, "production_management")');
  });
});
