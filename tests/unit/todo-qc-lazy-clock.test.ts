import {randomUUID} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import type {BusinessClock} from '@dx-rework/domain/business-clock';
import type {TodoSelection} from '../../apps/api/src/todos/selection.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {factoryProductionQcTodos} from '../../apps/api/src/production-platform/factory-production-qc-todos.js';
import {garmentQualityTodos} from '../../apps/api/src/production-platform/garment-quality-todos.js';
const fixtures=vi.hoisted(()=>({rows:[] as Array<{task_id:string;event_id:string;production_order_id:string;order_id:string;receipt_id:string;created_at:Date;recorded_at:Date;assignee_id:string;design_style_no:string}>,
 factoryFacts:vi.fn(async(_db:unknown,ids:readonly string[])=>new Map(ids.map(id=>[id,{complete:false,checks:[{factoryDecisionId:null,lineId:'TEST-line',quantity:5,inspected:false,targetDate:'2026-11-10'}]}]))),
 plans:vi.fn(async()=>new Map()),
}));
vi.mock('../../apps/api/src/production-platform/factory-production-facts.js',()=>({factoryProductionFactsForOrders:fixtures.factoryFacts}));
vi.mock('../../apps/api/src/production-platform/garment-sla-evidence.js',()=>({garmentSlaEvidence:async(_db:unknown,id:string)=>({quality:[{receiptId:fixtures.rows.find(row=>row.order_id===id)!.receipt_id,inspected:false,quantityVersion:2,quantity:5,receivedAt:'2026-11-08T00:00:00Z'}],windows:[{receiptId:fixtures.rows.find(row=>row.order_id===id)!.receipt_id,deadline:'2026-11-10T00:00:00Z',startedAt:'2026-11-08T00:00:00Z',warningAt:null}]})}));
vi.mock('../../apps/api/src/production-platform/sla-plan-repository.js',()=>({SlaPlanRepository:class{latestPlans=fixtures.plans;}}));
afterEach(()=>{vi.restoreAllMocks();fixtures.factoryFacts.mockClear();fixtures.plans.mockClear();});
describe('QC candidate display clocks are deferred',()=>{
 it.each(['factory','garment'] as const)('%s keeps all31 candidates and deadlines but reads clocks only for the selected15',async kind=>{
  const actor={actorId:randomUUID(),actorRoles:['quality_control'],authorizationCapability:'todo:view',requestId:'TEST-QC-lazy'};
  vi.spyOn(DigitalProductionAccessPolicy.prototype,'activeRole').mockResolvedValue(true);vi.spyOn(DigitalProductionAccessPolicy.prototype,'allowed').mockResolvedValue(true);
  fixtures.rows=Array.from({length:31},(_,index)=>{const order=randomUUID();return{task_id:randomUUID(),event_id:randomUUID(),production_order_id:order,order_id:order,receipt_id:randomUUID(),created_at:new Date('2026-11-08T00:00:00Z'),recorded_at:new Date('2026-11-08T00:00:00Z'),assignee_id:actor.actorId,design_style_no:`TEST-${index}`};});
  const db={query:vi.fn(async()=>({rows:fixtures.rows}))} as unknown as Pool,read=vi.fn(async()=>({now:'2026-11-08T01:00:00.000Z',scenarioId:null,revision:0})),clock={read} as unknown as BusinessClock,selected:TodoSelection[]=[];
  const run=kind==='factory'?factoryProductionQcTodos:garmentQualityTodos;
  expect(await run(db,actor,clock,{countOnly:true,select:(key,load)=>selected.push({key,load})})).toEqual([]);
  if(kind==='factory'){
   const orders=fixtures.rows.map(row=>row.order_id);
   expect(fixtures.factoryFacts).toHaveBeenCalledExactlyOnceWith(db,orders);
   expect(fixtures.plans).toHaveBeenCalledExactlyOnceWith(orders);
  }
  expect(selected).toHaveLength(31);expect(selected.every(item=>item.key.dueAt)).toBe(true);expect(read).not.toHaveBeenCalled();
  const page=await Promise.all(selected.slice(15,30).map(item=>item.load()));expect(page).toHaveLength(15);expect(read).toHaveBeenCalledTimes(15);
  expect(read.mock.calls.map(call=>call[0])).toEqual(fixtures.rows.slice(15,30).map(row=>({kind:'order',id:row.order_id})));
  expect(page.every(todo=>todo.timing?.asOf==='2026-11-08T01:00:00.000Z')).toBe(true);
 });
});
