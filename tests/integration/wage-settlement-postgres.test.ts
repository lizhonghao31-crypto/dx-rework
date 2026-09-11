import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const url=process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("wage settlement filtered range",()=>{
 const schema=`wage_marker_${randomUUID().replaceAll("-","")}`;
 const admin=new pg.Pool({connectionString:url});
 const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const finance=randomUUID(),viewer=randomUUID(),other=randomUUID(),person=randomUUID(),sameName=randomUUID();
 const actor=(id=finance,canMark=true):TrustedActorContext=>({actorId:id,actorRoles:["finance_director"],requestId:randomUUID(),authorizationCapability:"wage:view",authorizationCapabilities:["wage:view","wage:export",...(canMark?["wage:settlement_mark"]:[])]});
 const service=new ManagementReportingService(db);
 const filters={from:"2026-09-11",to:"2026-09-11",limit:500};
 let firstId:string;
 const insertLine=async (personId:string,type:string,completedAt:string,locked=false)=>{
  const id=randomUUID(),period=randomUUID(),order=randomUUID(),report=randomUUID();
  await db.query("INSERT INTO rework_wage_periods VALUES($1,'2026-09-01',$2)",[period,locked?"locked":"ready_to_lock"]);
  await db.query("INSERT INTO rework_orders VALUES($1,'completed')",[order]);
  await db.query("INSERT INTO rework_work_reports VALUES($1,$2)",[report,completedAt]);
  await db.query(`INSERT INTO rework_wage_items VALUES($1,$2,$3,$4,$5,'同名工人',$6,'RW-test','S-test','车缝',1,'piece',1,'individual',1)`,[id,period,order,report,personId,type]);
  if(locked){const closure=randomUUID();await db.query("INSERT INTO rework_wage_month_closures VALUES($1,$2)",[closure,period]);
   await db.query(`INSERT INTO rework_wage_month_close_lines VALUES($1,$2,$3,'wage_item',$4,'同名工人',$5,'RW-test','S-test','车缝',1,'piece',1,'individual',1)`,[randomUUID(),closure,id,personId,type]);}
  return id;
 };
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Small isolated SQL fixture: these tests exercise report/marker semantics, not the order workflow.
  await db.query(`CREATE TABLE capability_catalog(capability text PRIMARY KEY,display_name text,description text);
   CREATE TABLE role_capabilities(role_code text,capability text,PRIMARY KEY(role_code,capability));
   CREATE FUNCTION immutable_catalog() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
   CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog FOR EACH ROW EXECUTE FUNCTION immutable_catalog();
   CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION immutable_catalog();
   CREATE TABLE app_users(id uuid PRIMARY KEY);
   CREATE TABLE test_grants(user_id uuid,capability text);
   CREATE FUNCTION access_authorized_actor_roles(target uuid,requested text) RETURNS text[] LANGUAGE plpgsql AS $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM test_grants WHERE user_id=target AND capability=requested) THEN RAISE EXCEPTION 'forbidden'; END IF;
    RETURN ARRAY['finance_director']; END $$;
   CREATE TABLE rework_wage_periods(period_id uuid PRIMARY KEY,period_month date,status text);
   CREATE TABLE rework_orders(rework_order_id uuid PRIMARY KEY,status text);
   CREATE TABLE rework_work_reports(work_report_id uuid PRIMARY KEY,completed_at timestamptz);
   CREATE TABLE rework_wage_items(wage_item_id uuid PRIMARY KEY,period_id uuid,rework_order_id uuid,work_report_id uuid,person_id uuid,
    person_name_snapshot text,person_type_snapshot text,rework_no_snapshot text,style_no_snapshot text,process_name_snapshot text,
    actual_quantity_snapshot numeric,pricing_unit_snapshot text,unit_price_snapshot numeric,assignment_mode text,payable_amount numeric);
   CREATE TABLE rework_wage_month_closures(closure_id uuid PRIMARY KEY,period_id uuid);
   CREATE TABLE rework_wage_month_close_lines(closure_line_id uuid PRIMARY KEY,closure_id uuid,wage_item_id uuid,line_type text,
    person_id uuid,person_name_snapshot text,person_type_snapshot text,rework_no_snapshot text,style_no_snapshot text,process_name_snapshot text,
    quantity_snapshot numeric,unit_snapshot text,unit_price_snapshot numeric,assignment_mode text,final_amount numeric);`);
  await db.query(await readFile(new URL("../../apps/api/migrations/0171_wage_settlement_marks.sql",import.meta.url),"utf8"));
  for(const id of [finance,viewer,other]){await db.query("INSERT INTO app_users VALUES($1)",[id]);await db.query("INSERT INTO test_grants VALUES($1,'wage:view')",[id]);}
  await db.query("INSERT INTO test_grants VALUES($1,'wage:settlement_mark'),($1,'wage:export')",[finance]);
  firstId=await insertLine(person,"internal","2026-09-10T16:00:00Z");
  for(let i=1;i<501;i++)await insertLine(person,"internal","2026-09-11T08:00:00Z");
  await insertLine(sameName,"temporary","2026-09-11T15:59:59Z",true);
  await insertLine(person,"internal","2026-09-10T15:59:59Z");
  await insertLine(person,"internal","2026-09-11T16:00:00Z");
 },30000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it("uses the whole filtered range, distinguishes same-name people and includes both date boundaries",async()=>{
  const report=await service.report(actor(),"wages",filters);
  expect(report.rows).toHaveLength(500);expect(report.truncated).toBe(true);
  expect(report.totals.wageAmount).toBe("502.00");
  expect(report.wageSummary).toMatchObject({rowCount:502,pendingLineCount:502,pendingPersonCount:2});
  expect(report.wageSummary?.people.map(p=>p.personId).sort()).toEqual([person,sameName].sort());
  const temporary=await service.report(actor(),"wages",{...filters,personType:"temporary"});
  expect(temporary.rows).toHaveLength(1);expect(temporary.rows[0]?.settlementStatus).toBe("unsettled");
  expect((await service.exportData(actor(),"wages",filters)).data.rows).toHaveLength(502);
 });
 it("marks only the confirmed IDs, skips retries, keeps marker/time and leaves future wages unpaid",async()=>{
  const preview=await service.previewWageSettlement(actor(),filters);
  expect(preview).toMatchObject({personCount:2,lineCount:502});
  const laterId=await insertLine(person,"internal","2026-09-11T09:00:00Z");
  const before=await db.query("SELECT sum(payable_amount)::text total FROM rework_wage_items");
  expect(await service.markWageSettlement(actor(),filters,preview.lineIds)).toEqual({markedCount:502});
  const original=await db.query("SELECT * FROM rework_wage_settlement_marks WHERE line_id=$1",[firstId]);
  expect(await service.markWageSettlement(actor(),filters,preview.lineIds)).toEqual({markedCount:0});
  expect((await db.query("SELECT * FROM rework_wage_settlement_marks WHERE line_id=$1",[firstId])).rows).toEqual(original.rows);
  expect((await db.query("SELECT * FROM rework_wage_settlement_marks WHERE line_id=$1",[laterId])).rowCount).toBe(0);
  expect((await db.query("SELECT sum(payable_amount)::text total FROM rework_wage_items")).rows).toEqual(before.rows);
  expect((await db.query("SELECT DISTINCT status FROM rework_orders")).rows).toEqual([{status:"completed"}]);
  const reread=await new ManagementReportingService(db).report(actor(),"wages",filters);
  expect(reread.wageSummary).toMatchObject({pendingPersonCount:1,pendingLineCount:1});
 });
 it("rechecks filters and rejects both absent and forged marker capabilities",async()=>{
  const pending=await service.previewWageSettlement(actor(),filters);
  expect(await service.markWageSettlement(actor(),{...filters,personType:"temporary"},pending.lineIds)).toEqual({markedCount:0});
  await expect(service.previewWageSettlement(actor(viewer,false),filters)).rejects.toMatchObject({statusCode:403});
  await expect(service.markWageSettlement(actor(other,true),filters,pending.lineIds)).rejects.toThrow("forbidden");
  const grants=await db.query("SELECT role_code FROM role_capabilities WHERE capability='wage:settlement_mark' ORDER BY role_code");
  expect(grants.rows.map(r=>r.role_code)).toEqual(["finance_director","finance_read","wage_month_close_accountant"]);
 });
});
