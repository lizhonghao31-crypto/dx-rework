import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { supplierFixture, supplierInput } from "../helpers/supplier-fixture.js";
import { SupplierOnboardingService } from "../../apps/api/src/access/supplier-onboarding-service.js";
import { SupplierOnboardingProfileSchema } from "@dx-rework/contracts/supplier-onboarding";
import { TodoService } from "../../apps/api/src/todos/service.js";
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const profile = (name: string) => {
  const { supplierCode: _code, changeReason: _reason, ...input } = supplierInput(name); void _code; void _reason;
  return SupplierOnboardingProfileSchema.parse(input);
};
(url ? describe : describe.skip)("supplier onboarding lifecycle", () => {
  it("rejects revoked applicant and reviewer snapshots before reads, writes and idempotent replay", async () => {
    const f = await supplierFixture();
    const service = new SupplierOnboardingService(f.db);
    const applicant = f.actors.order_merchandiser!, reviewer = f.actors.production_management!;
    const root = { ...f.actors.root_superuser!, authorizationCapability: "access:admin", authorizationCapabilities: ["access:admin"] };
    try {
      const input = profile("撤权申请"), key = randomUUID();
      const id = (await service.submit(applicant, input, key)).response.requestId;
      const assignments = await f.service.listRoleAssignments({ userId: applicant.actorId });
      const applicantRole = assignments.find(item => item.roleCode === "order_merchandiser" && !item.revokedAt)!;
      await f.service.revokeRole(root, applicantRole.assignmentId, "验证申请人旧身份失效");
      await expect(service.get(applicant, id)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.list(applicant, "mine")).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.submit(applicant, input, key)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.submit(applicant, profile("撤权后新申请"), randomUUID())).rejects.toMatchObject({ statusCode: 403 });

      const reviewerRole = (await f.service.listRoleAssignments({ userId: reviewer.actorId })).find(item => item.roleCode === "production_management" && !item.revokedAt)!;
      await f.service.revokeRole(root, reviewerRole.assignmentId, "验证审批人旧身份失效");
      await expect(service.get(reviewer, id)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.list(reviewer, "pending")).rejects.toMatchObject({ statusCode: 403 });
      for (const decision of ["approved", "returned"] as const) {
        await expect(service.decide(reviewer, id, decision, decision === "returned" ? { version: 1, reason: "旧页面提交" } : { version: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      }
      expect((await f.db.query("SELECT status,supplier_id FROM supplier_onboarding_requests WHERE request_id=$1", [id])).rows).toEqual([{ status: "pending_approval", supplier_id: null }]);
      expect((await f.db.query("SELECT 1 FROM supplier_onboarding_decisions WHERE request_id=$1", [id])).rows).toHaveLength(0);
      expect((await f.db.query("SELECT 1 FROM operation_events WHERE entity_type='supplier_onboarding' AND entity_id=$1", [id])).rows).toHaveLength(1);
      expect((await f.db.query("SELECT 1 FROM current_supplier_catalog WHERE supplier_name IN ('撤权申请','撤权后新申请')")).rows).toHaveLength(0);
      const approved = await service.decide(f.actors.owner_group!, id, "approved", { version: 1 }, randomUUID());
      expect(approved.response.supplierId).toBeTruthy();
      expect((await f.db.query("SELECT 1 FROM current_supplier_catalog WHERE supplier_name='撤权申请'")).rows).toHaveLength(1);
    } finally { await f.close(); }
  }, 120000);
  it("scopes sensitive records, versions returns and atomically approves with audit, formal data and peer todo completion", async () => {
    const f = await supplierFixture();
    const service = new SupplierOnboardingService(f.db);
    const applicant = f.actors.embroidery_washing_merchandiser!, other = f.actors.order_merchandiser!, reviewer = f.actors.owner_group!;
    try {
      const input = profile("版本申请"), key = randomUUID();
      const created = await service.submit(applicant, input, key), id = created.response.requestId;
      expect((await service.submit(applicant, input, key)).reused).toBe(true);
      expect((await service.list(applicant, "mine"))).toHaveLength(1);
      expect((await service.list(other, "mine"))).toHaveLength(0);
      await expect(service.get(other, id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.list(applicant, "all")).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.decide(applicant, id, "approved", { version: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      for (const role of ["owner_group", "production_management", "root_superuser", "system_admin", "ie_reviewer"]) await expect(service.submit(f.actors[role]!, profile(role), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      expect((await service.get(applicant, id)).profile.bankAccount).toBe("001234567890");
      expect((await service.get(applicant, id)).duplicateCheck).toBeUndefined();
      expect((await service.get(reviewer, id)).duplicateCheck).toMatchObject({ formalSupplierCount: 0, pendingRequestCount: 0 });
      expect((await f.db.query("SELECT 1 FROM role_capabilities WHERE role_code='embroidery_washing_merchandiser' AND capability='supplier_contract_data:read'")).rows).toHaveLength(0);
      expect((await f.db.query("SELECT 1 FROM current_supplier_catalog WHERE supplier_name='版本申请'")).rows).toHaveLength(0);
      expect((await f.db.query("SELECT 1 FROM rework_todos WHERE entity_id=$1 AND status='pending'", [id])).rows).toHaveLength(2);
      const todoActor = { ...reviewer, authorizationCapability: "todo:view", authorizationCapabilities: ["todo:view"] };
      const inbox = await new TodoService(f.db).listForActor(todoActor, { module: "suppliers" });
      expect(inbox.todos).toHaveLength(1);
      expect(inbox.todos[0]?.orderContext?.supplierName).toBe("版本申请");
      await expect(service.submit(other, input, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      await expect(service.resubmit(other, id, { version: 1, profile: input }, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.decide(reviewer, id, "returned", { version: 1, reason: " " }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
      await service.decide(reviewer, id, "returned", { version: 1, reason: "核对联系电话" }, randomUUID());
      expect((await f.db.query("SELECT 1 FROM rework_todos WHERE entity_id=$1 AND status='pending'", [id])).rows).toHaveLength(1);
      await expect(service.decide(reviewer, id, "approved", { version: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      await service.resubmit(applicant, id, { version: 1, profile: { ...input, contactPhone: "新电话" } }, randomUUID());
      const detail = await service.get(reviewer, id);
      expect(detail.versions.map(v => v.profile.contactPhone)).toEqual(["123456789", "新电话"]);
      expect(detail.decisions[0]?.reason).toBe("核对联系电话");
      await expect(service.decide(reviewer, id, "approved", { version: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      const approvedKey = randomUUID();
      const approved = await service.decide(f.actors.production_management!, id, "approved", { version: 2 }, approvedKey);
      expect((await service.decide(f.actors.production_management!, id, "approved", { version: 2 }, approvedKey)).reused).toBe(true);
      expect((await f.db.query("SELECT bank_account,contact_phone FROM current_supplier_catalog WHERE supplier_id=$1", [approved.response.supplierId])).rows[0]).toEqual({ bank_account: "001234567890", contact_phone: "新电话" });
      expect((await service.get(applicant, id)).status).toBe("approved");
      expect((await f.db.query("SELECT 1 FROM rework_todos WHERE entity_id=$1 AND status IN ('pending','blocked_recipient')", [id])).rows).toHaveLength(0);
      await expect(service.resubmit(applicant, id, { version: 2, profile: input }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.db.query("UPDATE supplier_onboarding_request_versions SET profile='{}' WHERE request_id=$1", [id])).rejects.toMatchObject({ code: "55000" });
      expect((await f.db.query("SELECT 1 FROM operation_events WHERE entity_type='supplier_onboarding' AND entity_id=$1", [id])).rows).toHaveLength(4);
    } finally { await f.close(); }
  }, 120000);
  it("blocks approval if direct creation has reserved the name and rolls back a failed todo closure", async () => {
    const f = await supplierFixture();
    const service = new SupplierOnboardingService(f.db);
    try {
      const applicant = f.actors.order_merchandiser!, reviewer = f.actors.owner_group!;
      const first = (await service.submit(applicant, profile("期间直接新增"), randomUUID())).response.requestId;
      await f.service.createSupplier(reviewer, { ...supplierInput("期间直接新增"), active: false });
      expect((await service.get(reviewer, first)).duplicateCheck).toMatchObject({ formalSupplierCount: 1, pendingRequestCount: 0 });
      await expect(service.decide(reviewer, first, "approved", { version: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      expect((await service.get(applicant, first)).status).toBe("pending_approval");
      const second = (await service.submit(applicant, profile("事务回滚"), randomUUID())).response.requestId;
      await f.db.query("CREATE FUNCTION fail_supplier_todo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected closure failure'; END $$");
      await f.db.query("CREATE TRIGGER fail_supplier_todo BEFORE UPDATE ON rework_todos FOR EACH ROW EXECUTE FUNCTION fail_supplier_todo()");
      await expect(service.decide(reviewer, second, "approved", { version: 1 }, randomUUID())).rejects.toThrow("injected closure failure");
      expect((await service.get(applicant, second)).status).toBe("pending_approval");
      expect((await f.db.query("SELECT 1 FROM current_supplier_catalog WHERE supplier_name='事务回滚'")).rows).toHaveLength(0);
      expect((await f.db.query("SELECT 1 FROM supplier_onboarding_decisions WHERE request_id=$1", [second])).rows).toHaveLength(0);
    } finally { await f.close(); }
  }, 120000);
  it("serializes concurrent submissions and competing reviewers", async () => {
    const f = await supplierFixture(); const service = new SupplierOnboardingService(f.db);
    try {
      const results = await Promise.allSettled([service.submit(f.actors.order_merchandiser!, profile("并发申请"), randomUUID()), service.submit(f.actors.embroidery_washing_merchandiser!, profile("并发申请"), randomUUID())]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const success = results.find(r => r.status === "fulfilled")!; if (success.status !== "fulfilled") throw new Error("missing application");
      const id = success.value.response.requestId;
      const decisions = await Promise.allSettled([service.decide(f.actors.owner_group!, id, "approved", { version: 1 }, randomUUID()), service.decide(f.actors.production_management!, id, "approved", { version: 1 }, randomUUID())]);
      expect(decisions.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect((await f.db.query("SELECT 1 FROM current_supplier_catalog WHERE supplier_name='并发申请'")).rows).toHaveLength(1);
    } finally { await f.close(); }
  }, 120000);
});
