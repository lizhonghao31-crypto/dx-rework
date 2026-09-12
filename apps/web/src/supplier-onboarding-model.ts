import { CreateSupplierSchema } from "@dx-rework/contracts";
import { SupplierOnboardingProfileSchema, type SupplierOnboardingDetail, type SupplierOnboardingProfile, type SupplierOnboardingStatus } from "@dx-rework/contracts/supplier-onboarding";
import type { AuthorizedUser } from "./auth.js";
import { canWriteSupplierProfiles } from "./supplier-center-model.js";
import { emptyDraft, supplierDraftPayload, type SupplierDraft } from "./supplier-profile-draft.js";
export const SUPPLIER_REQUEST_STATUS: Record<SupplierOnboardingStatus, string> = { pending_approval: "待审批", returned: "已退回", approved: "已通过" };
const directRole = (user: AuthorizedUser) => user.isRoot === true || user.businessRoles?.some(role => ["owner_group", "production_management"].includes(role)) === true;
export const canRequestSupplier = (user: AuthorizedUser): boolean => !directRole(user) && user.capabilities.includes("supplier_onboarding:request")
  && user.businessRoles?.some(role => ["order_merchandiser", "embroidery_washing_merchandiser"].includes(role)) === true;
export const canApproveSupplier = (user: AuthorizedUser): boolean => user.isRoot === true || (directRole(user) && user.capabilities.includes("supplier_onboarding:approve"));
export const canAccessSupplierMaintenance = (user: AuthorizedUser): boolean => canWriteSupplierProfiles(user) || canRequestSupplier(user);
export const supplierApplicationDraft = (profile: SupplierOnboardingProfile): SupplierDraft => ({
  ...emptyDraft(), ...profile, contractEntityName: profile.contractEntityName ?? "", partyBRepresentative: profile.partyBRepresentative ?? "",
  supportedCrafts: profile.supportedCrafts.join("、"), dailyCapacity: profile.dailyCapacity == null ? "" : String(profile.dailyCapacity),
});
export function supplierApplicationPayload(draft: SupplierDraft) {
  const parsed = supplierDraftPayload({ ...draft, supplierCode: "", active: true }, { creating: true, code: "APPLICATION", version: 0 });
  if (!parsed.success) return parsed;
  const { supplierCode: _code, changeReason: _reason, ...profile } = CreateSupplierSchema.parse(parsed.data); void _code; void _reason;
  const value = SupplierOnboardingProfileSchema.safeParse(profile);
  return value.success ? { success: true as const, data: value.data } : { success: false as const, error: value.error.issues[0]?.message ?? "请检查必填资料" };
}

export function supplierApplicationVersion(detail: SupplierOnboardingDetail, version: number) {
  const selected = detail.versions.find(item => item.version === version)
    ?? { version: detail.version, profile: detail.profile, submittedAt: detail.createdAt };
  const decision = detail.decisions.find(item => item.version === selected.version);
  const status: SupplierOnboardingStatus = decision?.decision ?? (selected.version === detail.version ? detail.status : "pending_approval");
  return { ...selected, status, decision };
}
