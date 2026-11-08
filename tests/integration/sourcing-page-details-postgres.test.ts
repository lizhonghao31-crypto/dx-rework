import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {CreateSourcingCaseSchema} from '@dx-rework/contracts';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const caseCount=Number(process.env.M01_SOURCING_LIST_CASES??31);
if(!Number.isInteger(caseCount)||caseCount<31||caseCount>1000)throw Error('Owned sourcing fixture supports31–1000 cases only');
(url?describe.sequential:describe.skip)('PERF09 native sourcing page details',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,service:SourcingService;
 const reader=(actor=f.root)=>({...actor,authorizationCapability:'sourcing:view'});
 const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,value)=>key==='contractReturnAsOf'?undefined:value));
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);service=new SourcingService(f.db);
  const craft=(await f.access.ensureCrafts(f.people['production-management']!,{craftNames:['TEST-PERF09-工艺']}))[0]!;
  for(let i=0;i<caseCount;i++){
   const body=CreateSourcingCaseSchema.parse({gender:i%2?'女装':'男装',styleName:'TEST-PERF09-类型',estimatedCutPieceSendDate:'2026-12-01',deliveryDate:'2027-01-10',daxingUnitPrice:'5',attachmentIds:[await f.image(f.people.merchandiser!)],lineItems:Array.from({length:8},(_,line)=>({styleNo:'TEST-PERF09-'+String(i).padStart(2,'0')+'-'+line,color:'TEST色'+line,quantity:2}))});
   const created=await f.sourcing.createCase(f.people.merchandiser!,body,randomUUID());
   if(i<5){const linePrices=body.lineItems.map((_,position)=>({position:position+1,unitPrice:'3.25'}));await f.sourcing.quoteIePrice(f.people.ie!,created.value.sourcingCaseId,{linePrices},randomUUID());await f.sourcing.recordManagementDecision(f.people['production-management']!,created.value.sourcingCaseId,{linePrices,craftIds:[craft.craftId],supplierId:f.supplierId,cuttingProcess:'in_house'},randomUUID());if(i===0)await f.sourcing.decideOwner(f.people.owner!,created.value.sourcingCaseId,{decision:'approved'},randomUUID());}
  }
  const scene=await f.scene('2026-11-01T02:00:00.000Z');await f.runtime.run(scene,f.root,()=>f.bulkReady('无'));
 });
 afterAll(async()=>{await f?.dispose();});
 it('preserves full totals and actual role fields while rich native aggregates run only for the selected15',async()=>{
  const original=f.db.query,queries:Array<{text:string;values:unknown[]}>=[];
  const trace=vi.spyOn(f.db,'query').mockImplementation(function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].startsWith('WITH filtered_cases'))queries.push({text:args[0],values:args[1] as unknown[]});return Reflect.apply(original,f.db,args);} as typeof f.db.query);
  try{
   const first=await service.listCases(reader()),second=await service.listCases(reader(),'','all',2),last=await service.listCases(reader(),'','all',3),totals=(await f.db.query('SELECT count(*)::int AS count,sum(order_quantity)::int AS quantity FROM current_sourcing_cases')).rows[0]!;
   expect(first.totalCount).toBe(caseCount+1);expect(first.totalCount).toBe(totals.count);expect(first.totalOrderQuantity).toBe(totals.quantity);expect([first.items.length,second.items.length,last.items.length]).toEqual([15,15,Math.min(15,caseCount-29)]);expect(new Set([...first.items,...second.items,...last.items].map(item=>item.sourcingCaseId)).size).toBe(Math.min(45,caseCount+1));
   const selected=queries[0]!,plan=(await f.db.query('EXPLAIN (ANALYZE,VERBOSE,FORMAT JSON) '+selected.text,selected.values)).rows[0]['QUERY PLAN'][0].Plan;
   const nodes=(node:Record<string,unknown>):Array<Record<string,unknown>>=>[node,...((node.Plans??[]) as Array<Record<string,unknown>>).flatMap(nodes)],aggregates=nodes(plan).filter(node=>node['Node Type']==='Aggregate'&&(node.Output as string[]|undefined)?.some(value=>value.includes('jsonb_agg')));
   expect(aggregates.length).toBeGreaterThan(0);for(const aggregate of aggregates)expect(Number(aggregate['Actual Loops'])).toBeLessThanOrEqual(15);
   if(process.env.M01_SOURCING_LIST_BASELINE_MODULE){const module=await import(process.env.M01_SOURCING_LIST_BASELINE_MODULE),baseline=new module.SourcingService(f.db);
    type Variant=[query?:string,status?:'all'|'pending'|'closed',page?:number,filters?:Parameters<SourcingService['listCases']>[4]];
    const variants:Variant[]=[[],['','all',2],['TEST-PERF09-','all',3],['not-found'],['TEST anchor factory'],['TEST-PERF09-00-0'],['','pending',1,{stage:'ie'}],['','all',1,{gender:'女装'}],['','all',1,{contractReturn:'pending'}],['','all',1,{styleName:'TEST-PERF09-类型'}]];
    for(const actor of [reader(),reader(f.people.merchandiser!)])for(const patch of variants)expect(normalize(await service.listCases(actor,...patch))).toEqual(normalize(await baseline.listCases(actor,...patch)));
    await baseline.listCases(reader());const oldQuery=queries.at(-1)!,oldPlan=(await f.db.query('EXPLAIN (ANALYZE,VERBOSE,FORMAT JSON) '+oldQuery.text,oldQuery.values)).rows[0]['QUERY PLAN'][0].Plan;
    const oldAggregates=nodes(oldPlan).filter(node=>node['Node Type']==='Aggregate'&&(node.Output as string[]|undefined)?.some(value=>value.includes('jsonb_agg')));expect(oldAggregates.some(node=>Number(node['Actual Loops'])>15)).toBe(true);
    const before:number[]=[],after:number[]=[];await baseline.listCases(reader(),'TEST-PERF09-');
    for(let i=0;i<3;i++){let start=performance.now();const old=await baseline.listCases(reader(),'TEST-PERF09-');before.push(performance.now()-start);start=performance.now();const current=await service.listCases(reader(),'TEST-PERF09-');after.push(performance.now()-start);expect(normalize(current)).toEqual(normalize(old));}
    console.log('SOURCING_NATIVE_PAGE_COMPARE '+JSON.stringify({base:process.env.M01_SOURCING_LIST_BASELINE_HEAD,caseCount,before,after,oldRichAggregateLoops:oldAggregates.map(node=>node['Actual Loops']),richAggregateLoops:aggregates.map(node=>node['Actual Loops']),scope:'Same isolated legacy cases with8lines,5 native price decisions and1 approval; additional linked digital case included in correctness checks. Only observation field contractReturnAsOf excluded; no onsite/P95 claim.'}));
   }
  }finally{trace.mockRestore();}
 });
});
