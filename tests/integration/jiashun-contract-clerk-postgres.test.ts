import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { JiashunContractClerkScope, JIASHUN_READ } from "../../apps/api/src/sourcing/jiashun-contract-clerk-scope.js";

const databaseUrl=process.env.TEST_DATABASE_URL;
const withPostgres=databaseUrl?describe:describe.skip;

withPostgres("嘉顺专职文员：隔离PostgreSQL角色与供应商ID权限",()=>{
  const schema=ownedPostgresSchema("sourcing");
  const admin=new pg.Pool({connectionString:databaseUrl!});
  const database=new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const userId=randomUUID(),managerUserId=randomUUID(),concurrentUserId=randomUUID();
  const factoryIds=[randomUUID(),randomUUID(),randomUUID()];
  const roleInsert=(user:string,role:string)=>database.query(
    `INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
      VALUES($1,$2,$3,$4,'嘉顺角色隔离验证')`,[randomUUID(),user,role,managerUserId]);

  beforeAll(async()=>{
    await createOwnedPostgresSchema(admin,schema);
    const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {
      migrations:{version:string;checksum:string}[];
    };
    await database.query(`CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const client=await database.connect();
    try{
      for(const migration of manifest.migrations){
        await client.query("BEGIN");
        try{
          await client.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),"utf8"));
          await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[migration.version,migration.checksum]);
          await client.query("COMMIT");
        }catch(error){await client.query("ROLLBACK");throw error;}
      }
    }finally{client.release();}
    await database.query(`INSERT INTO app_users(id,display_name,enabled) VALUES
      ($1,'嘉顺文员',true),($2,'测试权限管理员',true),($3,'并发测试员工',true)`,[userId,managerUserId,concurrentUserId]);
    await database.query("ALTER TABLE supplier_catalog_items DISABLE TRIGGER supplier_catalog_items_require_initial_version");
    await database.query("ALTER TABLE supplier_catalog_versions DISABLE TRIGGER supplier_catalog_versions_guard_creation, DISABLE TRIGGER supplier_profile_maintenance_authority");
    try{
      await database.query(`INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type) VALUES
        ($1,'FAC_601BEF926B41','factory'),($2,'FAC_386DAEFCCF2E','factory'),($3,'FAC_7AACCD28B81F','factory')`,factoryIds);
      await database.query(`INSERT INTO supplier_catalog_versions(supplier_id,version,supplier_name,active,change_reason,changed_by)
        VALUES($1,1,'嘉顺七厂',true,'TEST',$4),($2,1,'嘉顺九厂',true,'TEST',$4),($3,1,'嘉顺十厂',true,'TEST',$4)`,[...factoryIds,managerUserId]);
    }finally{
      await database.query("ALTER TABLE supplier_catalog_versions ENABLE TRIGGER supplier_catalog_versions_guard_creation, ENABLE TRIGGER supplier_profile_maintenance_authority");
      await database.query("ALTER TABLE supplier_catalog_items ENABLE TRIGGER supplier_catalog_items_require_initial_version");
    }
    // The old audit insert guard is bypassed only for this isolated fixture;
    // the newly added exclusivity and delegation triggers are left enabled.
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
  });
  afterAll(async()=>{
    await database.end();
    await releaseOwnedPostgresSchema(admin,schema);
    await admin.end();
  });

  it("registers an exclusive role with exactly three scoped capabilities, no real user grant",async()=>{
    const caps=await database.query<{capability:string}>(`SELECT capability FROM role_capabilities
      WHERE role_code='jiashun_contract_clerk' ORDER BY capability`);
    expect(caps.rows.map(row=>row.capability)).toEqual([
      "sourcing:jiashun:contract_return","sourcing:jiashun:read","tools:jiashun_contract_file",
    ]);
    expect((await database.query("SELECT count(*)::int AS count FROM user_role_assignments WHERE role_code='jiashun_contract_clerk'")).rows[0].count).toBe(0);
  });

  it("automatically binds all three verified supplier codes to unique immutable IDs at first assignment",async()=>{
    expect((await database.query("SELECT count(*)::int AS count FROM sourcing_jiashun_allowed_factories")).rows[0].count).toBe(0);
    await roleInsert(userId,"jiashun_contract_clerk");
    const rows=await database.query<{factory_slot:number;supplier_id:string}>(`SELECT factory_slot,supplier_id
      FROM sourcing_jiashun_allowed_factories ORDER BY factory_slot`);
    expect(rows.rows).toEqual([{factory_slot:7,supplier_id:factoryIds[0]},{factory_slot:9,supplier_id:factoryIds[1]},{factory_slot:10,supplier_id:factoryIds[2]}]);
    const clerk={actorId:userId,actorRoles:["jiashun_contract_clerk"],authorizationCapability:JIASHUN_READ,
      authorizationCapabilities:[JIASHUN_READ,"sourcing:jiashun:contract_return","tools:jiashun_contract_file"],requestId:randomUUID()};
    await expect(new JiashunContractClerkScope(database).assertActive(clerk)).resolves.toBeUndefined();
    expect((await new SourcingService(database).listFactories(clerk)).items.map(item=>item.supplierId).sort()).toEqual([...factoryIds].sort());
  });

  it("rejects adding an unrelated role to the clerk and the reverse grant order",async()=>{
    await expect(roleInsert(userId,"production_management")).rejects.toMatchObject({code:"23514"});
    await roleInsert(managerUserId,"production_management");
    await expect(roleInsert(managerUserId,"jiashun_contract_clerk")).rejects.toMatchObject({code:"23514"});
  });

  it("serializes concurrent mixed grants: exactly one of the two roles can win",async()=>{
    const requests=await Promise.allSettled([
      roleInsert(concurrentUserId,"jiashun_contract_clerk"),
      roleInsert(concurrentUserId,"production_management"),
    ]);
    expect(requests.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(requests.filter(result=>result.status==="rejected")).toHaveLength(1);
    const assigned=await database.query("SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL",[concurrentUserId]);
    expect(assigned.rows).toHaveLength(1);
  });
});
