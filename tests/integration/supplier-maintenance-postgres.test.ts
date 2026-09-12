import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export async function supplierFixture() {
  const schema = `supplier_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url! });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
  const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as { migrations: { version: string; checksum: string }[] };
  await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64),applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)");
  for (const migration of manifest.migrations) {
    await db.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8"));
    await db.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]);
  }
  const service = new AccessMasterDataService(db, "corp");
  await service.ensureOrganizationPolicy();
  const actors: Record<string, TrustedActorContext> = {};
  for (const role of ["root_superuser", "owner_group", "production_management", "system_admin", "order_merchandiser", "embroidery_washing_merchandiser", "ie_reviewer"]) {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, role]);
    await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)", [randomUUID(), id, role]);
    const actor = { actorId: id, actorRoles: [role], authorizationCapability: "supplier_profile:write", authorizationCapabilities: ["supplier_profile:write"], requestId: randomUUID() };
    actors[role] = actor;
    if (role === "root_superuser") await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'root_superuser','corp')", [id]);
    else await service.assignRole({ ...actors.root_superuser!, actorRoles: ["root_superuser", "owner_group"], authorizationCapability: "access:admin", authorizationCapabilities: ["access:admin"] }, { userId: id, roleCode: role, reason: "供应商权限测试" });
  }
  return { db, service, actors, close: async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
export const supplierInput = (name: string, supplierType: "factory" | "fabric" = "factory") => ({
  supplierCode: `SUP_${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`, supplierName: name, supplierType,
  active: true, notes: "", supportedCrafts: ["车缝"], dailyCapacity: 100,
  contactPerson: "联系人", contactPhone: "123456789", address: "测试地址", contractEntityName: null,
  partyBRepresentative: null, payeeName: "收款人", bankAccount: "001234567890", bankName: "测试银行", changeReason: "新增资料",
});
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
