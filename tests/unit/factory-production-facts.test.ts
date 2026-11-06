import {describe,it,expect} from 'vitest';
import type {Pool} from 'pg';
import {factoryProductionFacts,factoryProductionCompletion} from '../../apps/api/src/production-platform/factory-production-facts.js';
const scope=(factory:string|null,quantity=100)=>({production_order_id:'production',factory_decision_id:factory,line_id:'po',quantity,supplier_name_snapshot:'factory',po_number:'PO',color:'黑',target_date:'2026-10-23'});
const event=(factory:string|null,quantity=100,result='需处理',at='2026-10-23T01:00:00Z')=>({event_id:`event-${factory}-${at}`,occurred_at:at,display_name:'QC',payload:{productionId:'production',factoryDecisionId:factory,checks:[{lineId:'po',allocationQuantity:quantity,result,problem:result==='需处理'?'缝线问题':''}]}});
const read=(scopes:unknown[],events:unknown[])=>factoryProductionFacts({query:async(sql:string)=>({rows:sql.includes('factory_garment_qc')?events:scopes})} as unknown as Pick<Pool,'query'>,'order');
describe('factory inspection native scope projection',()=>{
 it('keeps native production completion within the selected PO and preserves the all-PO reader default',async()=>{
  const scopes=[{...scope(null),execution_status:'shipped'},{...scope('other'),line_id:'other-po',execution_status:'producing'}],transitions=[{production_order_id:'production',factory_decision_id:null,business_date:'2026-10-23',actor_id:'reporter',display_name:'TEST reporter'}];
  const db={query:async(sql:string)=>({rows:sql.includes("t.status='production_completed'")?transitions:scopes})} as unknown as Pick<Pool,'query'>;
  expect(await factoryProductionCompletion(db,'order')).toMatchObject({completed:false,actualDate:null});
  expect(await factoryProductionCompletion(db,'order',['po'])).toMatchObject({completed:true,actualDate:'2026-10-23'});
  expect(await factoryProductionCompletion(db,'order',['other-po'])).toMatchObject({completed:false,actualDate:null});
  expect(await factoryProductionCompletion(db,'order',[])).toMatchObject({completed:false,actualDate:null});
 });
 it('ends inspection independently of failed quality and preserves first completion through recheck',async()=>{
  const result=await read([scope(null)],[event(null),event(null,100,'合格','2026-10-23T02:00:00Z')]);
  expect(result.complete).toBe(true);expect(result.checks[0]).toMatchObject({result:'合格',completedAt:'2026-10-23T01:00:00.000Z'});expect(result.history[0]?.checks[0]?.result).toBe('需处理');
 });
 it('does not reuse old factory completion for a new factory or enlarged scope',async()=>{
  expect((await read([scope('new')],[event(null)])).complete).toBe(false);
  expect((await read([scope(null,120)],[event(null)])).complete).toBe(false);
  expect((await read([scope(null,40)],[event(null)])).complete).toBe(true);
 });
 it('requires all active factory scopes and uses their actual QC end, not reporter status',async()=>{
  expect((await read([scope(null,40),scope('new',60)],[event(null)])).complete).toBe(false);
  const result=await read([scope(null,40),scope('new',60)],[event(null),event('new',60,'需处理','2026-10-23T03:00:00Z')]);
  expect(result.facts['factory_production:po']).toMatchObject({businessCompleted:true,completedAt:'2026-10-23T03:00:00.000Z'});
 });
});
