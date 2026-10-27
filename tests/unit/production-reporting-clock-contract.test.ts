import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
const read=(path:string)=>readFile(new URL(`../../${path}`,import.meta.url),'utf8');
describe('production calendar trust and compatibility contract',()=>{
 it('changes only the date source inside the three existing SQL guards',async()=>{
  const before=await read('apps/api/migrations/0236_factory_remainder_executions.sql'),after=await read('apps/api/migrations/0264_production_reporting_business_calendar.sql');
  const old=before.slice(before.indexOf('CREATE OR REPLACE FUNCTION guard_sourcing_production_report()'),before.indexOf('CREATE OR REPLACE FUNCTION guard_sourcing_production_shipment()'));
  const expected=old.replaceAll("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date",'sourcing_production_business_date(NEW.production_order_id,NEW.operation_event_id)')
   .replace("(transfer.effective_at AT TIME ZONE 'Asia/Shanghai')::date=NEW.business_date",'sourcing_production_business_date(NEW.production_order_id,NEW.operation_event_id)=NEW.business_date');
  expect(after.slice(after.indexOf('CREATE OR REPLACE FUNCTION guard_sourcing_production_report()'))).toBe(expected);
 });
 it('keeps the current-transaction, real database, Root corporation, dual-UAT and clock-version proof in SQL',async()=>{
  const sql=await read('apps/api/migrations/0264_production_reporting_business_calendar.sql');
  for(const proof of ['current_database()',"audit_xid IS DISTINCT FROM (txid_current()%4294967296)::text","i.corp_id=scene.corporation_id","b.corp_id=scene.corporation_id","b.provider_user_id='uat-root'","i.union_id LIKE 'uat-union-%'","i.active AND i.employed","r.role_code='owner_group'","scene.version::text","IS DISTINCT FROM scene.business_now",'case_mother IS DISTINCT FROM production_mother'])expect(sql).toContain(proof);
  expect(sql).not.toMatch(/current_setting|set_config|SECURITY DEFINER|DISABLE TRIGGER/i);
  expect(sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b/i);
  expect(sql).toContain("IF audit.action='sourcing.factory_change.effective' THEN");
  expect(sql).toContain('transfer.production_order_id=target AND transfer.operation_event_id=audit_id');
  expect(sql).toContain("RETURN (transferred_at AT TIME ZONE 'Asia/Shanghai')::date");
 });
 it('does not reinstate wall-clock controls or change the real transfer cutoff',async()=>{
  const page=await read('apps/web/src/production-reporting-page.tsx'),api=await read('apps/api/src/sourcing/production-reporting-service.ts'),transfer=await read('apps/api/src/sourcing/factory-transfer-service.ts');
  expect(page).not.toMatch(/\btoday\s*=|max=\{today\(/);expect(page).toContain('max={businessToday}');
  expect(api).not.toContain('dateCheck(');expect(api).toContain('expiresAt:new Date(Date.now()+86400000)');
  expect(transfer).toContain('sourcing_production_business_date($2,$4),event.actor_id,event.event_id,transfer.effective_at');
 });
});
