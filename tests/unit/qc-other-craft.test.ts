import { describe, expect, it } from "vitest";
import { CreateReworkDraftSchema, specialProcessLabel, specialProcessName } from "@dx-rework/contracts";

import { ensureOtherCraftComplete, resolveSpecialProcess } from "../../apps/api/src/rework/special-process.js";

describe("QC other craft business boundary", () => {
  it.each([
    [{}, "inspection", true],
    [{ tailInspectionRequired: false }, "none", false],
    [{ specialProcessType: "other_craft" as const, otherCraftDescription: " 包边 " }, "other_craft", true],
  ])("normalizes a new draft %j", (input, type, required) => {
    expect(resolveSpecialProcess(input)).toMatchObject({ specialProcessType: type, tailInspectionRequired: required });
  });

  it("keeps an older client's update from silently changing an other-craft order", () => {
    expect(resolveSpecialProcess({ tailInspectionRequired: true }, {
      special_process_type: "other_craft", other_craft_description: "整查", tail_inspection_required: true,
    })).toEqual({ specialProcessType: "other_craft", otherCraftDescription: "整查", tailInspectionRequired: true });
  });

  it("clears content on switching off, and does not restore it from inactive submitted fields", () => {
    expect(resolveSpecialProcess({ specialProcessType: "none", otherCraftDescription: "不适用内容" }, {
      special_process_type: "other_craft", other_craft_description: "包边", tail_inspection_required: true,
    })).toEqual({ specialProcessType: "none", otherCraftDescription: null, tailInspectionRequired: false });
  });

  it.each([undefined, "inspection", "none", "other_craft"] as const)("keeps the legacy boundary for requested type %s", (type) => {
    const existing = { special_process_type: null, other_craft_description: null, tail_inspection_required: true };
    if (type === undefined) expect(resolveSpecialProcess({}, existing).specialProcessType).toBeNull();
    else expect(() => resolveSpecialProcess({ specialProcessType: type }, existing)).toThrow("仅对更新后新建");
  });

  it("rejects contradictory flags and keeps inhouse finishing outside the feature", () => {
    expect(() => resolveSpecialProcess({ specialProcessType: "other_craft", tailInspectionRequired: false })).toThrow("不一致");
    expect(() => resolveSpecialProcess({ specialProcessType: "other_craft" }, undefined, true)).toThrow("本厂做尾");
  });

  it.each([null, "", "   "])("allows incomplete draft content %j but refuses submission", description => {
    const draft = resolveSpecialProcess({ specialProcessType: "other_craft", otherCraftDescription: description });
    expect(draft.otherCraftDescription).toBeNull();
    expect(() => ensureOtherCraftComplete({ special_process_type: draft.specialProcessType, other_craft_description: draft.otherCraftDescription })).toThrow("请填写其他工艺内容");
  });

  it("validates the content limit and renders explicit type even if the content itself is 整查", () => {
    expect(CreateReworkDraftSchema.safeParse({ specialProcessType: "other_craft", otherCraftDescription: "工".repeat(100) }).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({ specialProcessType: "other_craft", otherCraftDescription: "工".repeat(101) }).success).toBe(false);
    expect(specialProcessName({ specialProcessType: "other_craft", otherCraftDescription: "整查" })).toBe("其他工艺：整查");
    expect(specialProcessName({ specialProcessType: null })).toBe("整查");
    expect(specialProcessLabel({ specialProcessType: "other_craft" })).toBe("其他工艺");
  });
});
