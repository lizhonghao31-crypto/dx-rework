import {it,expect} from 'vitest';
import type {Pool} from 'pg';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '../../packages/contracts/src/digital-sla.js';
import {reworkSlaEvidence} from '../../apps/api/src/production-platform/rework-sla-evidence.js';
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const row={line_id:'po',rework_order_id:'rework',status:'pending_order_review',start_event_id:'assigned',started_at:'2026-10-20T01:00:00Z',snapshot_id:'frozen',rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters,item_count:2,assigned_items:2,task_count:3,completed_tasks:3,completed_at:'2026-10-21T01:00:00Z'};
const read=(rows:unknown[])=>reworkSlaEvidence({query:async(sql:string)=>({rows:sql.includes("event_kind='sla_standard_applied'")?[]:sql.includes('SELECT child_id,line_id')?rows.map(r=>({child_id:(r as typeof row).rework_order_id,line_id:(r as typeof row).line_id})):rows})} as unknown as Pick<Pool,'query'>,'mother');
it('ends at effective work before overall/financial completion and uses the frozen 48h window',async()=>{
 const result=await read([row]);expect(result.windows[0]).toMatchObject({complete:true,deadline:'2026-10-22T01:00:00.000Z',completedAt:'2026-10-21T01:00:00.000Z',snapshotId:'frozen'});
 expect(result.facts['garment_rework:po']?.businessCompleted).toBe(true);
});
it('does not use overall completed when a current work report is missing/rejected or a process has no task',async()=>{
 for(const patch of [{completed_tasks:2},{assigned_items:1},{started_at:null}])expect((await read([{...row,status:'completed',...patch}])).windows[0]).toMatchObject({complete:false,completedAt:null});
});
it('keeps historical missing standard unknown and does not multiply receipt quantities',async()=>{
 const result=await read([{...row,snapshot_id:null}]);expect(result.windows[0]?.deadline).toBeNull();expect(result.windows[0]?.warningAt).toBeNull();
 expect(JSON.stringify(result)).not.toMatch(/receivedQuantity|actualQuantity|shipmentQuantity/);
});
