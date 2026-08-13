import { describe, expect, it } from "vitest";

import {
  buildTodoPresentation,
  todoPresentationForCategory,
} from "@dx-rework/contracts";

describe("todo business presentation", () => {
  it("turns the work-report return category into a Chinese order summary", () => {
    expect(buildTodoPresentation({
      category: "work_report_return",
      deliveryKind: "create",
      orderContext: {
        reworkNo: "RW-2026-0813-001",
        orderNo: "PO-88",
        styleNo: "DX-1001",
      },
    })).toEqual({
      subject: "返工上数被退回",
      description: [
        "款号：DX-1001",
        "返工单：RW-2026-0813-001",
        "订单号：PO-88",
        "事项：请修正被退回的完成数量记录后重新提交。",
      ].join("\n"),
    });
  });

  it("uses the wage month for wage tasks and marks reminders clearly", () => {
    expect(buildTodoPresentation({
      category: "wage_month_close",
      deliveryKind: "reminder",
      wagePeriodMonth: "2026-08-01",
    })).toEqual({
      subject: "提醒：返工工资待月结",
      description: "工资月份：2026-08\n事项：请在资料齐全后锁定本月返工工资。",
    });
  });

  it("never exposes an unknown internal category as user-facing text", () => {
    expect(todoPresentationForCategory("internal_future_category")).toEqual({
      title: "返工业务待办",
      action: "请进入返工系统查看并处理。",
    });
  });

  it("gives every current and retained todo category a Chinese business title", () => {
    const categories = [
      "process_configuration", "process_configuration_return",
      "process_configuration_rejection_notice", "configuration_notice", "ie_review",
      "task_assignment", "work_reporting", "whole_order_review", "work_report_return",
      "quantity_adjustment", "responsibility_determination", "high_multiplier_confirmation",
      "owner_signature", "own_factory_approval", "external_supplier_selection",
      "external_business_signoff", "external_payables_confirmation", "external_payables_return",
      "external_deduction_follow_up", "external_deduction_overdue", "external_responsibility",
      "wage_tail_review", "wage_administrative_review", "wage_month_close",
      "wage_adjustment_approval", "wage_tail_review_submitted",
      "wage_administrative_review_submitted", "wage_adjustment_requested", "wage_review",
      "todo_escalation",
    ];
    for (const category of categories) {
      const presentation = todoPresentationForCategory(category);
      expect(presentation.title).not.toBe("返工业务待办");
      expect(presentation.title).not.toContain("_");
    }
  });
});
