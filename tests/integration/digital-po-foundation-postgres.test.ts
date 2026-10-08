import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { migrationExecutionSql } from "../../scripts/deploy/migration-execution-compatibility.mjs";
import { applyMigrations } from "../../scripts/migration-lib.mjs";

const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)("PO foundation incremental migration and read-only historical inventory",()=>{
  const schema=ownedPostgresSchema("po_foundation");const admin=new pg.Pool({connectionString:url!});
  const database=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
  const actor=randomUUID(),order=randomUUID(),line=randomUUID();let history:unknown[]=[];
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {migrations:{version:string;checksum:string}[]};
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const client=await database.connect();
    try{
      const serverVersion=Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
      const additions=manifest.migrations.filter(row=>row.version==="0223_sourcing_factory_change_craft_names"||row.version>="0237").map(row=>row.version);
      const apply=async(row:{version:string;checksum:string})=>{
        const sql=await readFile(new URL(`../../apps/api/migrations/${row.version}.sql`,import.meta.url),"utf8");
        await client.query("BEGIN");try{await client.query(migrationExecutionSql({...row,sql},serverVersion));
          await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[row.version,row.checksum]);await client.query("COMMIT");}
        catch(error){await client.query("ROLLBACK");throw error;}
      };
      for(const row of manifest.migrations.filter(row=>!additions.includes(row.version)))await apply(row);
      history=(await client.query("SELECT version,checksum,applied_at::text FROM schema_migrations ORDER BY version")).rows;
      await client.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST legacy source',true)",[actor]);
      await client.query("INSERT INTO production_order_roots(production_order_id,workflow_generation,created_by) VALUES($1,'digital_production_v1',$2)",[order,actor]);
      await client.query(`INSERT INTO digital_production_orders(production_order_id,customer_code,product_group,design_style_no,order_date,contract_delivery_date,created_by,creation_hash)
        VALUES($1,'PD','男装','TEST-LEGACY','2026-10-08','2026-12-10',$2,$3)`,[order,actor,"a".repeat(64)]);
      await client.query(`INSERT INTO digital_production_po_lines(line_id,production_order_id,position,po_number,formal_style_no,color,delivery_date)
        VALUES($1,$2,1,'OLD-PO','OLD-FORMAL','黑','2026-12-10')`,[line,order]);
      await client.query("INSERT INTO digital_production_po_sizes(line_id,size,quantity) VALUES($1,'M',11)",[line]);
      await client.query(`INSERT INTO digital_production_delegations(delegation_id,production_order_id,delegate_id,purpose,granted_by,expires_at)
        VALUES($1,$2,$3,'technical',$3,CURRENT_TIMESTAMP+INTERVAL '1 day')`,[randomUUID(),order,actor]);
      for(const row of manifest.migrations.filter(row=>additions.includes(row.version)))await apply(row);
    }finally{client.release();}
  },120000);
  afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  it("keeps prior hashes/timestamps, identities, legacy dates, quantities and conflicting formal aliases",async()=>{
    expect((await database.query("SELECT version,checksum,applied_at::text FROM schema_migrations WHERE version< '0237' AND version<>'0223_sourcing_factory_change_craft_names' ORDER BY version")).rows).toEqual(history);
    expect((await database.query("SELECT line_id,po_number,formal_style_no,delivery_date::text,customer_warehouse_arrival_date,factory_delivery_date,customer_date_version,factory_date_version FROM digital_production_po_lines WHERE line_id=$1",[line])).rows[0])
      .toMatchObject({line_id:line,po_number:"OLD-PO",formal_style_no:"OLD-FORMAL",delivery_date:"2026-12-10",customer_warehouse_arrival_date:null,factory_delivery_date:null,customer_date_version:0,factory_date_version:0});
    expect((await database.query("SELECT quantity FROM digital_production_po_sizes WHERE line_id=$1",[line])).rows[0].quantity).toBe(11);
    expect((await database.query("SELECT count(*)::int n FROM digital_po_date_changes")).rows[0].n).toBe(0);
  });
  it("runs the complete operator report twice with zero writes, without assigning an unknown number or date",async()=>{
    const snapshot=async()=>JSON.stringify((await database.query(`SELECT (SELECT jsonb_agg(to_jsonb(x)) FROM digital_production_po_lines x) lines,
      (SELECT jsonb_agg(to_jsonb(x)) FROM digital_production_orders x) orders,
      (SELECT jsonb_agg(to_jsonb(x)) FROM digital_production_delegations x) delegations,
      (SELECT count(*) FROM audit_events) audit_count,(SELECT count(*) FROM operation_events) operation_count,
      (SELECT count(*) FROM digital_po_date_changes) date_count`)).rows);
    const before=await snapshot();const sql=await readFile(new URL("../../scripts/digital-po-history-report.sql",import.meta.url),"utf8");
    for(let i=0;i<2;i++){
      const client=await database.connect();
      try{
        const result=await client.query(sql) as unknown as pg.QueryResult[];
        const rows=result.find(result=>result.command==="SELECT")!.rows;
        expect(rows.map(row=>row.category)).toEqual(expect.arrayContaining(["po_alias_conflict","customer_date_unregistered","factory_date_unregistered_or_manual_contract","order_without_source","active_legacy_digital_delegation"]));
      }finally{client.release();}
      expect(await snapshot()).toBe(before);
    }
  });
  it("upgrades the frozen main prefix through the same craft migration into release without rewriting either ledger",async()=>{
    const mainSchema=ownedPostgresSchema("po_main_switch");
    await admin.query(`CREATE SCHEMA ${mainSchema}`);
    const main=new pg.Pool({connectionString:url!,options:`-c search_path=${mainSchema}`});
    try {
      const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {migrations:{version:string;checksum:string}[]};
      const frozen=JSON.parse(await readFile(new URL("../fixtures/migration-histories/main-ab028c31.json",import.meta.url),"utf8")) as {migrations:{version:string;checksum:string}[]};
      const serverVersion=Number((await main.query("SHOW server_version_num")).rows[0].server_version_num);
      await main.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      const execute=async(row:{version:string;checksum:string})=>{
        expect(manifest.migrations.find(item=>item.version===row.version)?.checksum).toBe(row.checksum);
        const sql=await readFile(new URL(`../../apps/api/migrations/${row.version}.sql`,import.meta.url),"utf8");
        const client=await main.connect();
        try {
          await client.query("BEGIN");
          await client.query(migrationExecutionSql({...row,sql},serverVersion));
          await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[row.version,row.checksum]);
          await client.query("COMMIT");
        } catch(error){await client.query("ROLLBACK");throw error;}
        finally{client.release();}
      };
      for(const row of frozen.migrations)await execute(row);
      const snapshot=async()=>(await main.query("SELECT version,checksum,applied_at::text FROM schema_migrations ORDER BY version")).rows;
      const old=await snapshot();
      await execute(manifest.migrations.find(row=>row.version==="0223_sourcing_factory_change_craft_names")!);
      const updatedMain=await snapshot();
      for(const row of old)expect(updatedMain.find(item=>item.version===row.version)).toEqual(row);
      const scoped=new URL(url!);scoped.searchParams.set("options",`-c search_path=${mainSchema}`);
      const result=await applyMigrations(scoped.toString());
      expect(result.currentVersion).toBe(manifest.migrations.at(-1)!.version);
      expect(result.applied).not.toContain("0223_sourcing_factory_change_craft_names");
      const release=await snapshot();
      expect(release).toHaveLength(manifest.migrations.length);
      for(const row of updatedMain)expect(release.find(item=>item.version===row.version)).toEqual(row);
      expect((await applyMigrations(scoped.toString())).applied).toEqual([]);
      expect(await snapshot()).toEqual(release);
    } finally {
      await main.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${mainSchema} CASCADE`);
    }
  },120000);
});
