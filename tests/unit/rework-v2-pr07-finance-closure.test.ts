import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ApproveExternalDeductionSpecialApprovalSchema,
  RequestExternalDeductionSpecialApprovalSchema,
  ReturnExternalDeductionSpecialApprovalSchema,
} from "@dx-rework/contracts/external-responsibility";
import { describe, expect, it } from "vitest";

describe("PR-07 finance closure", () => {
  it("requires a reason to request or return a deduction exception", () => {
    expect(RequestExternalDeductionSpecialApprovalSchema.safeParse({
      expectedCaseVersion: 2,
      reason: "",
      attachmentIds: [],
    }).success).toBe(false);
    expect(RequestExternalDeductionSpecialApprovalSchema.parse({
      expectedCaseVersion: 2,
      reason: "供应商仅确认部分扣款",
      attachmentIds: [randomUUID()],
    })).toMatchObject({ expectedCaseVersion: 2 });
    expect(ApproveExternalDeductionSpecialApprovalSchema.safeParse({
      expectedCaseVersion: 3,
      expectedRequestVersion: 1,
    }).success).toBe(true);
    expect(ReturnExternalDeductionSpecialApprovalSchema.safeParse({
      expectedCaseVersion: 3,
      expectedRequestVersion: 1,
      reason: "",
    }).success).toBe(false);
  });

  it("exposes only exact close or finance-director special approval actions", async () => {
    const [panel, routes, service, production] = await Promise.all([
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
      readFile("apps/api/src/rework/external-responsibility-routes.ts", "utf8"),
      readFile("apps/api/src/rework/external-responsibility-service.ts", "utf8"),
      readFile("apps/api/src/rework/production-external-responsibility-service.ts", "utf8"),
    ]);
    expect(panel).toContain("确认扣款完成");
    expect(panel).toContain("转财务总监特批");
    expect(panel).toContain("特批确认");
    expect(panel).not.toContain('operation(caseItem, "close-partial")');
    expect(panel).not.toContain('operation(caseItem, "close-none")');
    expect(routes).toContain("special-approval-requests");
    expect(routes).toContain("external_deduction:special_approve");
    expect(service).toContain("实际扣款未达到拟扣金额时必须转财务总监特批");
    expect(service).toContain('requiredRole:"finance_director"');
    expect(service).toContain("actionableForUniqueDirectRole");
    expect(production).toContain("value.canRequestSpecialApproval && followUp && permission.can_close");
  });

  it("locks the finance-director decision into append-only PostgreSQL facts and DingTalk todo delivery", async () => {
    const [migration, todoService] = await Promise.all([
      readFile("apps/api/migrations/0082_rework_v2_finance_closure.sql", "utf8"),
      readFile("apps/api/src/todos/service.ts", "utf8"),
    ]);
    expect(migration).toContain("pending_special_approval");
    expect(migration).toContain("rework_external_deduction_special_requests");
    expect(migration).toContain("rework_external_deduction_special_decisions");
    expect(migration).toContain("ARRAY['finance_director']");
    expect(migration).toContain("special approval closure is missing");
    expect(migration).toContain("_no_update");
    expect(migration).toContain("_no_delete");
    expect(migration).toContain("_no_truncate");
    expect(todoService).toContain('const TODO_DELIVERY_TOPIC = "todo.delivery"');
    expect(todoService).toContain("'dingtalk','queued'");
  });
});
