import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("PR-04 unified rework execution", () => {
  it("makes unified execution the only new-flow model", async () => {
    const migration = await read("apps/api/migrations/0079_rework_v2_unified_execution.sql");
    expect(migration).toContain("ADD COLUMN unified_execution_required boolean NOT NULL DEFAULT true");
    expect(migration).toContain("ADD COLUMN execution_kind text NOT NULL DEFAULT 'worker'");
    expect(migration).toContain("execution_kind IN ('worker','tail_inspection')");
    expect(migration).toContain("rework_process_configuration_one_tail_execution_idx");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION validate_responsibility_version");
    expect(migration).toContain("item.execution_kind = 'worker'");
  });

  it("uses the worker role for the preserved tail-inspection execution kind", async () => {
    const [roleMigration, auditGuard, plan, reporting, routes, access] = await Promise.all([
      read("apps/api/migrations/0093_tail_inspection_worker_role.sql"),
      read("apps/api/migrations/0085_n04_tail_work_report_audit_guard.sql"),
      read("apps/api/src/rework/process-worker-plan-service.ts"),
      read("apps/api/src/rework/work-reporting-service.ts"),
      read("apps/api/src/rework/work-reporting-routes.ts"),
      read("apps/api/src/access/service.ts"),
    ]);
    expect(plan).toContain("assignment.role_code IN ('worker','tail_inspector')");
    expect(reporting).toContain('task.execution_kind === "tail_inspection"');
    expect(reporting).toContain('return "tail_inspection:report"');
    expect(routes).toContain('user.businessRoles?.includes("worker")');
    expect(roleMigration).toContain("('worker','tail_inspection:report')");
    expect(roleMigration).toContain("tail inspection task member must be an active eligible worker");
    expect(access).toContain("br.role_code<>'tail_inspector'");
    expect(auditGuard.match(/'tail_inspection:report'/g)).toHaveLength(2);
    expect(auditGuard).toContain("event.action='rework.work_report.submit'");
    expect(auditGuard).toContain("event.entity_id=NEW.rework_order_id::text");
  });

  it("creates one explicit tail special process in N02 and never writes the retired tail-assignment path", async () => {
    const [form, configuration, contracts] = await Promise.all([
      read("apps/web/src/process-worker-assignment-form.tsx"),
      read("apps/api/src/rework/process-configuration-service.ts"),
      read("packages/contracts/src/index.ts"),
    ]);
    expect(form).toContain('customProcessName: response?.specialProcessType === "other_craft"');
    expect(form).toContain('executionKind: "tail_inspection" as const');
    expect(form).toContain("${specialLabel}候选单价（元/件）");
    expect(form).toContain('eligibleExecutionKinds.includes("tail_inspection")');
    expect(form).not.toContain("tail-inspection-options");
    expect(form).not.toContain("历史整查分配");
    expect(configuration).not.toContain("INSERT INTO rework_tail_inspection_assignments");
    expect(configuration).not.toContain('category: "tail_inspection"');
    expect(contracts).not.toContain("tailInspectors: z.array");
  });

  it("removes the independent tail node from the current flow", async () => {
    const detail = await read("apps/web/src/rework-detail-page.tsx");
    expect(detail).toContain('node("work_reporting", "04", detail.reworkKind === "inhouse_finishing" ? "本厂做尾报数" : "返工执行报数"');
    expect(detail).not.toContain('node("tail_inspection"');
    expect(detail).not.toContain("<TailInspectionPanel");
    expect(detail).not.toContain('if (value === "tail_inspection")');
    expect(detail).toContain('node("whole_order_review", "05", "尾部最终数量确认"');
    expect(detail).toContain('node("final_quantity_ie_review", "06", "IE 最终数量复核"');
    expect(detail).toContain('node("responsibility", "07", "责任判定"');
    expect(detail).toContain('node("owner_signature", "08", "老板确认签字"');
    expect(detail).toContain('node("settlement_followup", "09", "返工业务完成"');
  });

  it("uses work tasks and work reports as the execution quantity fact chain", async () => {
    const [reviewService, reviewPanel, reporting, responsibility] = await Promise.all([
      read("apps/api/src/rework/whole-order-review-service.ts"),
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/api/src/rework/work-reporting-service.ts"),
      read("apps/api/src/rework/responsibility-determination-service.ts"),
    ]);
    expect(reviewService).toContain("tail_item.execution_kind='tail_inspection'");
    expect(reviewService).toContain("item.execution_kind='worker'");
    expect(reviewPanel).toContain("历史整查报数记录");
    expect(reviewPanel).toContain('report.executionKind === "tail_inspection"');
    expect(reporting).toContain('task.execution_kind === "tail_inspection"');
    expect(reporting).toContain("rework_work_reports");
    expect(responsibility).toContain("item.execution_kind='worker'");
  });
});
