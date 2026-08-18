import { describe, expect, it } from "vitest";

import { buildTodoPresentation } from "@dx-rework/contracts";

describe("todo presentation", () => {
  it("includes the rework, order, and style numbers in an actionable card", () => {
    expect(buildTodoPresentation({
      category: "process_configuration",
      deliveryKind: "create",
      orderContext: {
        reworkNo: "RW-20260818-001",
        orderNo: "SO-20260818-008",
        styleNo: "STYLE-008",
      },
    })).toEqual({
      subject: "配置返工工序",
      description: "款号：STYLE-008\n返工单：RW-20260818-001\n订单号：SO-20260818-008\n事项：请配置工序、计划数量和单价。",
    });
  });

  it("keeps the same identifiers when a todo is sent as a reminder", () => {
    expect(buildTodoPresentation({
      category: "process_configuration",
      deliveryKind: "reminder",
      orderContext: { reworkNo: "RW-001", orderNo: "SO-001", styleNo: "STYLE-001" },
    })).toMatchObject({
      subject: "提醒：配置返工工序",
      description: "款号：STYLE-001\n返工单：RW-001\n订单号：SO-001\n事项：请配置工序、计划数量和单价。",
    });
  });
});
