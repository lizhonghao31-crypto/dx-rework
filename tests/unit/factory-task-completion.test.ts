import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import type {AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import {factorySlaEvidence} from '../../apps/api/src/production-platform/factory-sla-evidence.js';
import {attachFactoryTaskCompletions} from '../../apps/api/src/production-platform/factory-task-completion.js';
vi.mock('../../apps/api/src/production-platform/factory-sla-evidence.js',()=>({factorySlaEvidence:vi.fn()}));
const native=vi.mocked(factorySlaEvidence),at='2026-11-15T19:39:00.123Z';
const task=(id='task')=>({task_id:id,task_kind:'warehouse_dispatch',route_instance_id:'prep',production_order_id:'order',state:'completed',completed_at:new Date('2026-11-15T19:41:46.479Z'),completed_quality:'现场登记'});
const evidence=()=>({preparationId:'prep',craftKey:null,facts:{warehouse_dispatch:{businessCompleted:true,batchCoverageComplete:true}},windows:[{kind:'warehouse_dispatch',complete:true,completedAt:at}]}) as unknown as NonNullable<Awaited<ReturnType<typeof factorySlaEvidence>>>;
const db=(origins:unknown[],positions:unknown[]=[])=>({query:vi.fn(async(sql:string)=>{if(sql.includes('SELECT e.task_id,e.payload'))return {rows:origins};if(sql.includes('SELECT task_id,step_id'))return {rows:positions};throw Error('Unexpected source query');})}) as unknown as Pick<PoolClient,'query'>;
beforeEach(()=>native.mockResolvedValue(evidence()));
it('repairs only the old native automatic closeout and groups the read by order without modifying original events',async()=>{
 const origins=['first','second'].map(task_id=>({task_id,payload:{factId:'real-native-dispatch'},corrected:false})),snapshot=structuredClone(origins),rows=[task('first'),task('second')];
 await attachFactoryTaskCompletions(db(origins),rows);expect(rows.map(row=>row.completed_at?.toISOString())).toEqual([at,at]);expect(native).toHaveBeenCalledTimes(1);expect(origins).toEqual(snapshot);
});
it('never replaces an explicit corrected completion, including unknown, and leaves unrelated or new native contracts alone',async()=>{
 const known=task('corrected'),unknown={...task('unknown'),completed_at:null,completed_quality:'缺失'},newNative=task('new'),ordinary=task('ordinary'),rows=[known,unknown,newNative,ordinary];
 const before=structuredClone(rows);await attachFactoryTaskCompletions(db([{task_id:'corrected',payload:{factId:'native'},corrected:true},{task_id:'unknown',payload:{factId:'native'},corrected:true},{task_id:'new',payload:{factId:'native',actualSource:'factory-scoped-occurrence-v1'},corrected:false}]),rows);
 expect(rows).toEqual(before);expect(native).not.toHaveBeenCalled();
});
it('does not borrow the last completed time from a different preparation or an incomplete physical scope',async()=>{
 for(const source of [{...evidence(),preparationId:'other'}, {...evidence(),facts:{warehouse_dispatch:{businessCompleted:false,batchCoverageComplete:false}}}]){
  native.mockResolvedValue(source);const row=task();await attachFactoryTaskCompletions(db([{task_id:row.task_id,payload:{factId:'native'},corrected:false}]),[row]);expect(row.completed_at).toBeNull();expect(row.completed_quality).toBe('缺失');
 }
});
it('selects an immutable bulk step even when sibling tasks have the same kind; missing step evidence stays unknown',async()=>{
 const source={...evidence(),craftSteps:[{stepId:'first',craftKind:'printing',sequence:1},{stepId:'second',craftKind:'printing',sequence:2}] as AdoptedCraftStep[],facts:{},windows:[{kind:'bulk_qc',stepRef:'first',complete:true,completedAt:'2026-11-15T18:00:00Z'},{kind:'bulk_qc',stepRef:'second',complete:true,completedAt:at}]} as unknown as NonNullable<Awaited<ReturnType<typeof factorySlaEvidence>>>;
 native.mockResolvedValue(source);const rows=['first','second','missing'].map(id=>({...task(id),task_kind:'bulk_qc'}));
 await attachFactoryTaskCompletions(db(rows.map(row=>({task_id:row.task_id,payload:{factId:'native'},corrected:false})),rows.filter(row=>row.task_id!=='missing').map(row=>({task_id:row.task_id,step_id:row.task_id}))),rows);
 expect(rows.map(row=>row.completed_at?.toISOString()??null)).toEqual(['2026-11-15T18:00:00.000Z',at,null]);
});
