import type { SpecialProcessType } from "@dx-rework/contracts";

import { ApplicationError } from "../platform/errors.js";

type Input = Readonly<{
  specialProcessType?: SpecialProcessType | undefined;
  otherCraftDescription?: string | null | undefined;
  tailInspectionRequired?: boolean | undefined;
}>;
type Current = Readonly<{
  special_process_type?: SpecialProcessType | null;
  other_craft_description?: string | null;
  tail_inspection_required: boolean;
}>;

export const resolveSpecialProcess = (input: Input, current?: Current, finishing = false) => {
  const fail = (message: string): never => { throw new ApplicationError("VALIDATION_ERROR", message, 400); };
  const legacy = finishing || (current !== undefined && current.special_process_type == null);
  if (legacy && (input.specialProcessType !== undefined || input.otherCraftDescription != null)) {
    fail(finishing ? "本厂做尾不使用其他工艺" : "其他工艺仅对更新后新建的QC返工单开放");
  }
  const required = input.tailInspectionRequired ?? current?.tail_inspection_required ?? true;
  const mode = legacy ? null : input.specialProcessType
    ?? (required ? (current?.special_process_type === "other_craft" ? "other_craft" : "inspection") : "none");
  if (mode && input.tailInspectionRequired !== undefined && input.tailInspectionRequired !== (mode !== "none")) {
    fail("所选工艺与是否需要特殊工序不一致，请刷新后重试");
  }
  const description = mode === "other_craft"
    ? (input.otherCraftDescription === undefined ? current?.other_craft_description : input.otherCraftDescription)?.trim() || null
    : null;
  if (description && description.length > 100) fail("其他工艺内容最多100字");
  return { specialProcessType: mode, otherCraftDescription: description, tailInspectionRequired: mode ? mode !== "none" : required };
};

export const ensureOtherCraftComplete = (row: Pick<Current, "special_process_type" | "other_craft_description">): void => {
  if (row.special_process_type === "other_craft" && !row.other_craft_description?.trim()) {
    throw new ApplicationError("VALIDATION_ERROR", "请填写其他工艺内容", 400);
  }
};
