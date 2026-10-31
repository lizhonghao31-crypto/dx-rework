import { describe, expect, it } from "vitest";

import {
  CUTTING_RECORD_ROLES,
  CUTTING_VIEW_ROLES,
  CuttingOrderListItemSchema,
} from "@dx-rework/contracts";

describe("cutting source contract", () => {
  it("keeps formal and alternate style identities distinct in the safe projection", () => {
    const parsed = CuttingOrderListItemSchema.parse({
      cuttingOrderId: "00000000-0000-4000-8000-000000000001",
      sourcingCaseId: "00000000-0000-4000-8000-000000000002",
      sourcePosition: 1,
      formalStyleNo: null,
      alternateStyleNo: "TEMP-001",
      displayStyleNo: "TEMP-001",
      styleName: "测试款",
      gender: "女装",
      color: "黑色",
      contractNumber: null,
      contractQuantity: 100,
      supplierId: "00000000-0000-4000-8000-000000000003",
      supplierName: "测试加工厂",
      merchandiserId: "00000000-0000-4000-8000-000000000004",
      merchandiserName: "测试跟单",
      deliveryDate: "2026-09-30",
      cuttingProcess: "in_house",
      cuttingProcessOther: null,
      processes: ["车缝"],
      approvedAt: "2026-09-18T08:00:00.000Z",
      status: "pending",
      pieceCount: null,
      actualCutCount: null,
      recordedByName: null,
      recordedAt: null,
      outOfRange: null,
    });
    expect(parsed.formalStyleNo).toBeNull();
    expect(parsed.displayStyleNo).toBe("TEMP-001");
  });

  it("adds warehouse supervisor as a reader while keeping recorder roles unchanged", () => {
    expect(CUTTING_VIEW_ROLES).toEqual([
      "cutting_supervisor",
      "cutting_worker",
      "owner_group",
      "production_management",
      "pmc",
      "order_merchandiser",
      "warehouse_supervisor",
    ]);
    expect(CUTTING_RECORD_ROLES).toEqual(["cutting_supervisor","cutting_worker"]);
    for (const excluded of ["warehouse_receiver","warehouse_keeper","pattern_room_supervisor","pattern_room_worker"]) {
      expect(CUTTING_VIEW_ROLES).not.toContain(excluded as never);
      expect(CUTTING_RECORD_ROLES).not.toContain(excluded as never);
    }
    expect(CUTTING_RECORD_ROLES).not.toContain("warehouse_supervisor");
  });
});
