import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { canApproveSupplier, canRequestSupplier, canAccessSupplierMaintenance, supplierApplicationDraft, supplierApplicationPayload, supplierApplicationVersion } from "../../apps/web/src/supplier-onboarding-model.js";
import { SupplierApplicationList, SupplierApplicationSnapshot, SupplierDuplicateCheck } from "../../apps/web/src/supplier-onboarding-page.js";
import { SupplierProfileForm } from "../../apps/web/src/supplier-profile-form.js";
import { SupplierCenterNavigation } from "../../apps/web/src/supplier-center-page.js";
import type { AuthorizedUser } from "../../apps/web/src/auth.js";
import type { SupplierOnboardingDetail, SupplierOnboardingProfile, SupplierOnboardingSummary } from "@dx-rework/contracts/supplier-onboarding";
const user = (role: string, capabilities: string[]): AuthorizedUser => ({ id: "fixture", displayName: "用户", businessRoles: [role], capabilities });
const profile: SupplierOnboardingProfile = { supplierName: "合成申请供应商", supplierType: "factory", active: true, notes: "测试备注", contactPerson: "测试联系人", contactPhone: "020-00000000", address: "合成地址", payeeName: "测试收款人", bankAccount: "001234567890", bankName: "测试银行", supportedCrafts: ["车缝", "整烫"], dailyCapacity: 1000 };
it("allows only the two applicant roles and prioritizes direct maintenance for mixed roles", () => {
  for (const role of ["order_merchandiser", "embroidery_washing_merchandiser"]) {
    const applicant = user(role, ["supplier_onboarding:request"]);
    expect(canRequestSupplier(applicant)).toBe(true); expect(canAccessSupplierMaintenance(applicant)).toBe(true); expect(canApproveSupplier(applicant)).toBe(false);
    expect(canRequestSupplier(user(role, []))).toBe(false);
    expect(canRequestSupplier({ ...applicant, businessRoles: [role, "owner_group"] })).toBe(false);
  }
  for (const role of ["owner_group", "production_management"]) {
    const reviewer = user(role, ["supplier_profile:write", "supplier_onboarding:approve"]);
    expect(canRequestSupplier(reviewer)).toBe(false); expect(canAccessSupplierMaintenance(reviewer)).toBe(true); expect(canApproveSupplier(reviewer)).toBe(true);
    expect(canApproveSupplier(user(role, []))).toBe(false);
  }
  for (const role of ["ie_reviewer", "system_admin", "finance_director", "quality_control"]) {
    const reader = user(role, ["supplier_profile:write", "supplier_onboarding:request", "supplier_onboarding:approve"]);
    expect(canRequestSupplier(reader)).toBe(false); expect(canApproveSupplier(reader)).toBe(false); expect(canAccessSupplierMaintenance(reader)).toBe(false);
  }
  expect(canApproveSupplier({ ...user("", []), isRoot: true })).toBe(true);
  expect(canRequestSupplier({ ...user("order_merchandiser", ["supplier_onboarding:request"]), isRoot: true })).toBe(false);
});
it("reuses full collection validation while keeping account text and server-owned fields out of applications", () => {
  const draft = supplierApplicationDraft(profile);
  const result = supplierApplicationPayload(draft);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  expect(result.data.bankAccount).toBe("001234567890");
  expect(result.data).not.toHaveProperty("supplierCode"); expect(result.data).not.toHaveProperty("changeReason");
  for (const patch of [{ contactPhone: "" }, { bankAccount: "" }, { supportedCrafts: "车缝、车缝" }, { dailyCapacity: "1.5" }]) expect(supplierApplicationPayload({ ...draft, ...patch }).success).toBe(false);
  const html = renderToStaticMarkup(createElement(SupplierProfileForm, { draft, onDraft: () => {}, busy: false, ready: true, creating: true, application: true, submitLabel: "提交申请", onSave: () => {}, onCancel: () => {} }));
  expect(html).toContain("提交申请"); expect(html).toContain('value="001234567890"');
  expect(html).not.toContain("供应商编码"); expect(html).not.toContain("启用状态");
});
it("renders immutable full snapshots and truthful applicant and reviewer list actions", () => {
  const snapshot = renderToStaticMarkup(createElement(SupplierApplicationSnapshot, { profile }));
  for (const heading of ["基础资料", "合同收款", "工艺产能"]) expect(snapshot).toContain(`<h3>${heading}</h3>`);
  expect(snapshot).toContain("001234567890"); expect(snapshot).toContain("合成地址"); expect(snapshot).not.toContain("<input");
  const rows: SupplierOnboardingSummary[] = ["pending_approval", "returned", "approved"].map((status, index) => ({ requestId: `00000000-0000-4000-8000-00000000000${index}`, applicantId: "fixture", applicantName: "申请人", supplierName: profile.supplierName, supplierType: "factory", status: status as SupplierOnboardingSummary["status"], version: index + 1, supplierId: null, createdAt: "2026-09-12T08:00:00Z", updatedAt: "2026-09-12T08:00:00Z" }));
  const applicant = renderToStaticMarkup(createElement(SupplierApplicationList, { items: rows, reviewer: false }));
  expect(applicant).toContain("修改"); expect(applicant).toContain("待审批"); expect(applicant).toContain("已通过"); expect(applicant).not.toContain(">审批</a>");
  const reviewer = renderToStaticMarkup(createElement(SupplierApplicationList, { items: rows, reviewer: true }));
  expect(reviewer).toContain(">审批</a>"); expect(reviewer).toContain("申请人"); expect(reviewer).not.toContain("查看并修改");
  expect(renderToStaticMarkup(createElement(SupplierCenterNavigation, { active: "directory", canMaintain: false }))).not.toContain("资料维护");
});

it("keeps historical status, name and submission time tied to the selected version", () => {
  const detail: SupplierOnboardingDetail = {
    requestId: "fixture", applicantId: "applicant", applicantName: "申请人", supplierName: "第二版名称", supplierType: "factory", status: "pending_approval",
    version: 2, supplierId: null, createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z", profile: { ...profile, supplierName: "第二版名称" },
    versions: [{ version: 1, profile, submittedAt: "2026-09-10T00:00:00Z" }, { version: 2, profile: { ...profile, supplierName: "第二版名称" }, submittedAt: "2026-09-12T00:00:00Z" }],
    decisions: [{ version: 1, decision: "returned", reason: "补充地址", reviewerName: "审批人", decidedAt: "2026-09-11T00:00:00Z" }],
  };
  expect(supplierApplicationVersion(detail, 1)).toMatchObject({ status: "returned", submittedAt: detail.createdAt, profile, decision: { reason: "补充地址" } });
  expect(supplierApplicationVersion(detail, 2)).toMatchObject({ status: "pending_approval", submittedAt: "2026-09-12T00:00:00Z", profile: { supplierName: "第二版名称" } });
  expect(supplierApplicationVersion({ ...detail, status: "approved" }, 1).status).toBe("returned");
  expect(renderToStaticMarkup(createElement(SupplierDuplicateCheck, { check: { formalSupplierCount: 1, pendingRequestCount: 0, checkedAt: detail.updatedAt } }))).toContain("发现同名同类型记录");
  expect(renderToStaticMarkup(createElement(SupplierDuplicateCheck, { check: { formalSupplierCount: 0, pendingRequestCount: 0, checkedAt: detail.updatedAt } }))).toContain("未发现同名同类型记录");
});
