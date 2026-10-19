import { z } from "zod";

export const SpecialProcessTypeSchema = z.enum(["none", "inspection", "other_craft"]);
export type SpecialProcessType = z.infer<typeof SpecialProcessTypeSchema>;

export const OtherCraftDescriptionSchema = z.string().trim().max(100).nullable().optional();

export type SpecialProcessContext = Readonly<{
  specialProcessType?: SpecialProcessType | null | undefined;
  otherCraftDescription?: string | null | undefined;
}>;

/** The execution kind remains tail_inspection; this is the business-facing name. */
export const specialProcessLabel = (context: SpecialProcessContext): string =>
  context.specialProcessType === "other_craft" ? "其他工艺" : "整查";

export const specialProcessName = (context: SpecialProcessContext): string =>
  context.specialProcessType === "other_craft"
    ? `其他工艺：${context.otherCraftDescription?.trim() ?? ""}`
    : "整查";
