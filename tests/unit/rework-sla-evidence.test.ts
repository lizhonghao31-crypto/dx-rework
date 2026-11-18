import {it,expect} from 'vitest';
import type {Pool} from 'pg';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '../../packages/contracts/src/digital-sla.js';
import {reworkSlaEvidence} from '../../apps/api/src/production-platform/rework-sla-evidence.js';
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const row={line_id:'po',rework_order_id:'rework',status:'pending_order_review',start_event_id:'assigned',started_at:'2026-10-20T01:00:00Z',snapshot_id:'frozen',rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters,item_count:2,assigned_items:2,task_count:3,proven_task_count:3,completed_tasks:3,completed_at:'2026-10-21T01:00:00Z'};
type ExecutionRow=Omit<typeof row,'started_at'|'snapshot_id'>&{started_at:string|null;snapshot_id:string|null};
const read=(rows:readonly ExecutionRow[])=>reworkSlaEvidence({query:async(sql:string,values:unknown[])=>{
 if(sql.startsWith('SELECT child_id,min(line_id::text) AS line_id FROM digital_production_child_lines')){
  expect(values).toEqual(['mother']);
  expect(sql).toContain('HAVING count(DISTINCT line_id)=1');
  return {rows:rows.map(value=>({child_id:value.rework_order_id,line_id:value.line_id}))};
 }
 if(sql.startsWith('SELECT r.rework_order_id,r.status,r.special_process_type,')){
  expect(values).toEqual([rows.map(value=>value.rework_order_id),'mother']);return {rows};
 }
 if(sql.includes("e.event_kind='sla_standard_applied'"))return {rows:[]};
 throw Error(`Unexpected rework evidence query: ${sql}`);
}} as unknown as Pick<Pool,'query'>,'mother');
it('ends at effective work before overall/financial completion and uses the frozen 48h window',async()=>{
 const result=await read([row]);expect(result.windows[0]).toMatchObject({complete:true,deadline:'2026-10-22T01:00:00.000Z',completedAt:'2026-10-21T01:00:00.000Z',snapshotId:'frozen'});
 expect(result.facts['garment_rework:po']?.businessCompleted).toBe(true);
});
it('does not use overall completed when a report, required process, or assignment proof is missing',async()=>{
 for(const patch of [{completed_tasks:2},{assigned_items:1},{proven_task_count:2},{started_at:null}])expect((await read([{...row,status:'completed',...patch}])).windows[0]).toMatchObject({complete:false,completedAt:null});
});
it('keeps historical missing standard unknown and does not multiply receipt quantities',async()=>{
 const result=await read([{...row,snapshot_id:null}]);expect(result.windows[0]?.deadline).toBeNull();expect(result.windows[0]?.warningAt).toBeNull();
 expect(JSON.stringify(result)).not.toMatch(/receivedQuantity|actualQuantity|shipmentQuantity/);
});
