import {describe,expect,it} from 'vitest';
import {businessTimeWriteViolations,checkBusinessTimeWriters} from '../../scripts/check-business-time-writes.mjs';
import {checkTimeSiteInventory} from '../../scripts/acceptance/time-site-inventory.mjs';

describe('business occurrence SQL writer contract',()=>{
 it('rejects implicit legacy defaults and wall time in both VALUES and batch SELECT writers',()=>{
  expect(businessTimeWriteViolations('INSERT INTO digital_factory_qc(check_id) VALUES($1)')).toEqual(['digital_factory_qc.checked_at: implicit SQL default']);
  expect(businessTimeWriteViolations('INSERT INTO rework_work_reports(work_report_id,completed_at) SELECT id,CURRENT_TIMESTAMP FROM input')).toEqual(['rework_work_reports.completed_at: SQL wall clock']);
  expect(businessTimeWriteViolations('INSERT INTO digital_bulk_cutting_completions(completed_at) VALUES(now())')).toHaveLength(1);
  expect(businessTimeWriteViolations('INSERT INTO sourcing_contract_business_ready_facts(business_ready_at) VALUES(clock_timestamp())')).toHaveLength(1);
 });
 it('preserves real audit/security time and accepts explicit occurrence parameters',()=>{
  expect(businessTimeWriteViolations('INSERT INTO operation_events(created_at) VALUES(CURRENT_TIMESTAMP)')).toEqual([]);
  expect(businessTimeWriteViolations('INSERT INTO sessions(expires_at) VALUES(CURRENT_TIMESTAMP)')).toEqual([]);
  expect(businessTimeWriteViolations('INSERT INTO digital_factory_qc(check_id,checked_at) VALUES($1,$2)')).toEqual([]);
 });
 it('checks all API files, so a new legacy or batch writer cannot silently use a protected SQL default',async()=>{
  expect(await checkBusinessTimeWriters()).toEqual([]);
 });
 it('requires newly introduced clock/default/date-control/anchor candidates to be recorded for semantic review',async()=>{
  expect(await checkTimeSiteInventory()).toEqual([]);
 });
});
