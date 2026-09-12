import { z } from "zod";
import { CreateSupplierSchema } from "./index.js";

export const SupplierOnboardingProfileSchema = CreateSupplierSchema.omit({ supplierCode: true, changeReason: true }).extend({
  active: z.literal(true).default(true),
  contactPerson: z.string().trim().min(1, "请填写联系人").max(100),
  contactPhone: z.string().trim().min(1, "请填写联系电话").max(50),
  address: z.string().trim().min(1, "请填写供应商地址").max(500),
  payeeName: z.string().trim().min(1, "请填写收款人").max(100),
  bankAccount: z.string().trim().min(1, "请填写收款账号").max(100),
  bankName: z.string().trim().min(1, "请填写开户行").max(200),
  supportedCrafts: CreateSupplierSchema.shape.supportedCrafts.unwrap().refine(value => value.length > 0, "请填写支持工艺"),
}).strict();
export const SupplierOnboardingVersionSchema = z.object({ version: z.number().int().positive() }).strict();
export const SupplierOnboardingReturnSchema = SupplierOnboardingVersionSchema.extend({ reason: z.string().trim().min(1, "请填写退回原因").max(500) }).strict();
export const SupplierOnboardingResubmitSchema = SupplierOnboardingVersionSchema.extend({ profile: SupplierOnboardingProfileSchema }).strict();
export type SupplierOnboardingProfile = z.infer<typeof SupplierOnboardingProfileSchema>;
export type SupplierOnboardingStatus = "pending_approval" | "returned" | "approved";
export type SupplierOnboardingSummary = {
  requestId: string; applicantId: string; applicantName: string; supplierName: string;
  supplierType: SupplierOnboardingProfile["supplierType"]; status: SupplierOnboardingStatus;
  version: number; supplierId: string | null; createdAt: string; updatedAt: string;
};
export type SupplierOnboardingDetail = SupplierOnboardingSummary & {
  profile: SupplierOnboardingProfile;
  versions: { version: number; profile: SupplierOnboardingProfile; submittedAt: string }[];
  decisions: { version: number; decision: "approved" | "returned"; reason: string | null; reviewerName: string; decidedAt: string }[];
};
