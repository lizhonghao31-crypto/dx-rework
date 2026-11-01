import { assertTestDatabaseTarget } from "../../scripts/test-database-safety.mjs";
import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "./owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const url = process.env.TEST_DATABASE_URL;
export async function supplierFixture() {
  await assertTestDatabaseTarget(url);
  const schema = ownedPostgresSchema("supplier");
  const admin = new pg.Pool({ connectionString: url! });
  await createOwnedPostgresSchema(admin,schema);
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
  return { db, service, actors, close: async () => { await db.end(); await dropOwnedPostgresSchema(admin,schema); await admin.end(); } };
}
export const supplierInput = (name: string, supplierType: "factory" | "fabric" = "factory") => ({
  supplierCode: `SUP_${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`, supplierName: name, supplierType,
  active: true, notes: "", supportedCrafts: ["车缝"], dailyCapacity: 100,
  contactPerson: "联系人", contactPhone: "123456789", address: "测试地址", contractEntityName: null,
  partyBRepresentative: null, payeeName: "收款人", bankAccount: "001234567890", bankName: "测试银行", changeReason: "新增资料",
});
