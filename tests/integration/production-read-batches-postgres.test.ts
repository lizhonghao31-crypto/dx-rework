import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {DigitalOrderCreateSchema,DigitalNumberCorrectionSchema} from '@dx-rework/contracts/digital-production';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
import {ProductionStatisticsQuery} from '../../apps/api/src/production-platform/production-statistics-query.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('PERF08 native production snapshot read batches',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,scene:string,query:ProductionStatisticsQuery;
 const ids:string[]=[],run=<T,>(fn:()=>Promise<T>)=>f.runtime.run(scene,f.root,fn);
 const filters=()=>DigitalAnalysisFilterSchema.parse({view:'production',from:'2026-11-01',to:'2026-11-30'});
 const normalize=(value:Awaited<ReturnType<ProductionStatisticsQuery['list']>>)=>{
  const {snapshotId,createdAt,expiresAt,...business}=value;void snapshotId;void createdAt;void expiresAt;return business;
 };
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);scene=await f.scene('2026-11-08T00:00:00.000Z');query=new ProductionStatisticsQuery(f.db);
  await run(async()=>{const identity=new DigitalProductionIdentityService(f.db,true);
   for(let i=0;i<31;i++){const order=await identity.createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-PERF08-'+i,orderDate:'2026-11-08',lines:[{formalPoNo:'TEST-PERF08-PO-'+i,color:'TEST黑',customerWarehouseArrivalDate:'2027-01-10',sizes:[{size:'M',quantity:2}]}]}),randomUUID());ids.push(order.productionOrderId);}
  });
 });
 afterAll(async()=>{await f?.dispose();});
 it('keeps complete31-order metrics and bounded15-row details with actual batched native reads',()=>run(async()=>{
  const originals=new Map<PoolClient,PoolClient['query']>(),sql:string[]=[];
  const trace=(client:PoolClient)=>{if(originals.has(client))return;const original=client.query;originals.set(client,original);client.query=function(this:PoolClient,...args:unknown[]){if(typeof args[0]==='string')sql.push(args[0]);return Reflect.apply(original,this,args);} as PoolClient['query'];};
  f.db.on('acquire',trace);
  try{
   const sample=async(reader:ProductionStatisticsQuery)=>{sql.length=0;const start=performance.now(),value=await reader.list(f.root,filters());return {value,ms:performance.now()-start,sql:sql.length,batches:sql.filter(text=>text.startsWith('SELECT requested.ordinal')).length};};
   const current=await sample(query);expect(current.value.total).toBe(31);expect(current.value.result.rows).toHaveLength(15);expect(current.value.result.metrics.demand.value).toBe(62);expect(current.batches).toBeGreaterThan(0);
   if(process.env.M01_PRODUCTION_STATS_BASELINE_MODULE){
    const module=await import(process.env.M01_PRODUCTION_STATS_BASELINE_MODULE),baseline=new module.ProductionStatisticsQuery(f.db),before:unknown[]=[],after:unknown[]=[];
    await sample(baseline);
    for(let i=0;i<3;i++){const old=await sample(baseline),now=await sample(query);expect(normalize(now.value)).toEqual(normalize(old.value));expect(now.sql).toBeLessThan(old.sql);before.push({ms:old.ms,sql:old.sql});after.push({ms:now.ms,sql:now.sql,batches:now.batches});}
    console.log('PRODUCTION_NATIVE_31_COMPARE '+JSON.stringify({base:process.env.M01_PRODUCTION_STATS_BASELINE_HEAD,before,after,scope:'Same isolated31-order fixture, same guarded time and actor; complete business response equal. Three local paired samples, no onsite or P95 claim.'}));
   }
   const next=await query.list(f.root,{...filters(),page:2,snapshotId:current.value.snapshotId});expect(next.total).toBe(31);expect(next.result.rows).toHaveLength(15);expect(next.result.metrics).toEqual(current.value.result.metrics);expect(next.result.rows.some(row=>current.value.result.rows.some(first=>first.line.lineId===row.line.lineId))).toBe(false);
  }finally{f.db.removeListener('acquire',trace);for(const [client,original]of originals)client.query=original;}
 }));
 it('reads a committed native PO correction on the next query without retaining the previous snapshot',()=>run(async()=>{
  const identity=new DigitalProductionIdentityService(f.db,true),before=await query.list(f.root,filters()),orderId=ids[0]!;
  const detail=await identity.read(f.root,orderId);
  await identity.correctNumbers(f.root,orderId,detail.lines[0]!.lineId,DigitalNumberCorrectionSchema.parse({expectedVersion:detail.version,formalPoNo:'TEST-PERF08-CORRECTED'}),randomUUID());
  const after=await query.list(f.root,filters(),true);expect(after.watermark).not.toBe(before.watermark);expect(after.result.metrics.demand.value).toBe(62);expect(after.result.rows.find(row=>row.line.orderId===orderId)?.line.poNumber).toBe('TEST-PERF08-CORRECTED');
 }));
});
