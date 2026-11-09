import {expect,it} from 'vitest';
import type {PoolClient} from 'pg';
import {journeyCutScopes} from '../../apps/api/src/production-platform/journey-cut-scopes.js';
const read=(rows:unknown[])=>journeyCutScopes({query:async()=>({rows})} as unknown as Pick<PoolClient,'query'>,'TEST-order');
it('does not turn missing cut evidence into known zero or a fabricated identity',async()=>{
 expect(await read([{line_id:'PO-a',child_id:null}])).toEqual([{lineId:'PO-a',status:'missing',cuts:[]}]);
});
it('keeps different native cut identities separate and marks unsupported multiple/incorrect source links unresolved',async()=>{
 const cut=(line:string,id:string,position:number,sourceLine=line)=>({line_id:line,child_id:id,sourcing_case_id:'CASE',sourcing_line_position:position,approval_snapshot_id:'APPROVAL',source_line_id:sourceLine});
 const rows=await read([cut('PO-a','CUT-1',1),cut('PO-b','CUT-2',2),cut('PO-b','CUT-3',3),cut('PO-c','CUT-4',4,'PO-a')]);
 expect(rows.map(row=>({id:row.lineId,status:row.status,cuts:row.cuts.map(cut=>cut.cuttingOrderId)}))).toEqual([
  {id:'PO-a',status:'verified',cuts:['CUT-1']},{id:'PO-b',status:'unresolved',cuts:['CUT-2','CUT-3']},{id:'PO-c',status:'unresolved',cuts:['CUT-4']}
 ]);
 expect(JSON.stringify(rows)).not.toContain('quantity');
});
