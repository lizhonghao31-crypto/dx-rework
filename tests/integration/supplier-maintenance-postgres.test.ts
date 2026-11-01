import { describe, expect, it } from "vitest";
import {supplierFixture,supplierInput} from "../helpers/supplier-maintenance-fixture.js";
const url=process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("supplier maintenance database authority", () => {
  it("allows Root, owner and production, rejects forged roles and preserves inactive identity and revisions", async () => {
    const f = await supplierFixture();
    try {
      for (const role of ["root_superuser", "owner_group", "production_management"]) {
        const created = await f.service.createSupplier(f.actors[role]!, supplierInput(role));
        const audit = await f.db.query("SELECT actor_roles,authorization_capability FROM operation_events WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 1", [created.supplierId]);
        expect(audit.rows[0].actor_roles).toContain(role);
        expect(audit.rows[0].authorization_capability).toBe("supplier_profile:write");
      }
      for (const role of ["system_admin", "order_merchandiser", "embroidery_washing_merchandiser", "ie_reviewer"]) {
        await expect(f.service.createSupplier({ ...f.actors[role]!, actorRoles: ["owner_group"] }, supplierInput(role))).rejects.toMatchObject({ statusCode: 403 });
      }
      const actor = f.actors.owner_group!;
      const created = await f.service.createSupplier(actor, { ...supplierInput("  Case   Supplier  "), active: false });
      await expect(f.service.createSupplier(actor, supplierInput("case supplier"))).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.service.createSupplier(actor, supplierInput("case supplier", "fabric"))).resolves.toMatchObject({ version: 1 });
      await expect(f.service.reviseSupplier(actor, created.supplierId, { expectedVersion: 1, active: true, changeReason: "恢复启用" })).resolves.toMatchObject({ version: 2 });
      await expect(f.service.reviseSupplier(actor, created.supplierId, { expectedVersion: 1, active: false, changeReason: "旧版本" })).rejects.toMatchObject({ statusCode: 409 });
    } finally { await f.close(); }
  }, 120000);
  it("serializes concurrent creation of the same name and type", async () => {
    const f = await supplierFixture();
    try {
      const results = await Promise.allSettled([
        f.service.createSupplier(f.actors.owner_group!, supplierInput("并发重复")),
        f.service.createSupplier(f.actors.production_management!, supplierInput("并发重复")),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
      expect((await f.db.query("SELECT * FROM current_supplier_catalog WHERE supplier_name='并发重复'")).rows).toHaveLength(1);
    } finally { await f.close(); }
  }, 120000);
});
