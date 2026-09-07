import { randomUUID } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { SampleAnalysisQuerySchema } from '../../packages/contracts/src/sample-analysis.js';
import { SampleAnalysisService,sampleAnalysisFilter } from '../../apps/api/src/samples/sample-analysis-service.js';
import { SampleReadService } from '../../apps/api/src/samples/sample-read-service.js';
import { registerSampleReadRoutes } from '../../apps/api/src/samples/sample-read-routes.js';
const id=randomUUID(),actor=(role:string)=>({actorId:id,actorRoles:[role],authorizationCapability:'sample:view_basic',authorizationCapabilities:['sample:view_basic','sample:view_finance'],requestId:'analysis-test'});
describe('sample analysis query and financial boundary',()=>{
 it.each([{purchaseFrom:'2026-02-30'},{purchaseFrom:'2026-09-02',purchaseTo:'2026-09-01'},{eventFrom:'2026-09-02',eventTo:'2026-09-01'},{minPrice:'2.01',maxPrice:'2'},{minPrice:'1e3'},{minPrice:'1.001'},{holderUserId:'同名员工'},{page:0},{pageSize:1000},{export:true}])('rejects unsupported query %j',q=>{expect(SampleAnalysisQuerySchema.safeParse(q).success).toBe(false);});
 it('keeps stable IDs and decimal price parameters out of SQL text',()=>{
  const q=SampleAnalysisQuerySchema.parse({purchaserUserId:id,holderUserId:randomUUID(),brand:"x' OR true --",minPrice:'999999999999.99'});
  const f=sampleAnalysisFilter(q);expect(f.where).not.toContain(q.brand);expect(f.where).not.toContain(id);expect(f.values).toContain(q.brand);expect(f.values).toContain('999999999999.99');expect(f.values).toContain(q.holderUserId);expect(f.values).toContain(id);
 });
 it.each(['sample_designer','sample_administrative','system_admin','worker'])('denies %s before parsing financial filters or reading',async role=>{
  const connect=vi.fn(),service=new SampleAnalysisService({connect} as unknown as Pool);
  await expect(service.read(actor(role),{minPrice:'invalid'})).rejects.toMatchObject({code:'FORBIDDEN'});expect(connect).not.toHaveBeenCalled();
 });
 it.each(['sample_finance','sample_approver','owner_group','root_superuser'])('allows %s through the financial guard and rolls back a query failure',async role=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockRejectedValueOnce(new Error('isolated DB failure')).mockResolvedValue({rows:[]}),release=vi.fn();
  const service=new SampleAnalysisService({connect:async()=>({query,release})} as unknown as Pool);
  await expect(service.read(actor(role),{})).rejects.toThrow('isolated DB failure');expect(query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(query).toHaveBeenLastCalledWith('ROLLBACK');expect(release).toHaveBeenCalledOnce();
 });
 it('protects the HTTP endpoint including malformed price filters',async()=>{
  const connect=vi.fn(),app=Fastify();registerSampleReadRoutes(app,{authenticate:async()=>({id,displayName:'合成用户',businessRoles:['sample_designer'],capabilities:['sample:view_basic']}),service:new SampleReadService({connect} as unknown as Pool)});
  for(const url of ['/samples/analysis','/samples/analysis?minPrice=bad','/samples/analysis?group=purchaser_brand'])expect((await app.inject({url})).statusCode).toBe(403);
  expect(connect).not.toHaveBeenCalled();await app.close();
 });
});
