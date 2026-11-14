import {describe,it,expect,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {readSeriesPlanFacts} from '../../apps/api/src/production-platform/series-plan-facts.js';
import {developmentDocumentRow} from '../../apps/api/src/production-platform/development-round-repository.js';
import {effectiveTechnicalEvidence} from '../../apps/api/src/production-platform/development-technical-repository.js';
vi.mock('../../apps/api/src/production-platform/development-round-repository.js',()=>({developmentDocumentRow:vi.fn(async(_db:unknown,_source:string,round=2)=>({version:round,round_number:round,document:{}}))}));
vi.mock('../../apps/api/src/production-platform/development-technical-repository.js',()=>({effectiveTechnicalEvidence:vi.fn(async()=>null)}));
vi.mock('../../apps/api/src/production-platform/bulk-fabric-facts.js',()=>({bulkFabricFacts:vi.fn(async()=>({report:null}))}));
vi.mock('../../apps/api/src/production-platform/preparation-material-repository.js',()=>({preparationAvailable:async()=>false,preparationContext:vi.fn(),preparationMaterialHistory:vi.fn(),currentPreparationMaterials:vi.fn()}));
describe('adopted development-round milestone facts',()=>{
 it('reads original round approval and evidence without borrowing a later rejection',async()=>{
  const queried:number[]=[];
  const db={query:async(sql:string,values:unknown[])=>{
   if(sql.includes('digital_series_source_events')||sql.includes('digital_factory_routes'))return {rows:[]};
   if(sql.includes('digital_development_final_comments')){const round=Number(values[1]);queried.push(round);return {rows:[{comment_id:'TEST-comment-'+round,scope_ref:'整款',version:1,decision:round===1?'approved':'rejected',occurred_at:round===1?'2027-01-06T00:00:00Z':'2027-01-09T00:00:00Z',customer_code:'PD'}]};}
   throw Error('Unexpected query '+sql);
  }} as unknown as Pick<PoolClient,'query'>;
  const original=await readSeriesPlanFacts(db,'TEST order','TEST source','PD',1);
  expect(developmentDocumentRow).toHaveBeenLastCalledWith(db,'TEST source',1);
  expect(effectiveTechnicalEvidence).toHaveBeenLastCalledWith(db,'TEST source',1,'整款','PD');
  expect(original.facts[0]).toMatchObject({key:'client_sample_approval',completed:true,occurredAt:'2027-01-06T00:00:00.000Z'});
  const latest=await readSeriesPlanFacts(db,'TEST order','TEST source','PD');
  expect(latest.facts[0]).toMatchObject({completed:false,occurredAt:'2027-01-09T00:00:00.000Z'});
  expect(queried).toEqual([1,2]);
 });
});
