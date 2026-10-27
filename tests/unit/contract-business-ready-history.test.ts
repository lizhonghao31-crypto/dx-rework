import {describe,expect,it,vi} from 'vitest';
import {firstContractBusinessReady} from '../../apps/api/src/production-platform/contract-business-ready.js';

const generated='2026-10-01T08:00:00.000Z',order='00000000-0000-4000-8000-000000000001',scene='00000000-0000-4000-8000-000000000002';
function history(scope:string|null,fact?:Record<string,unknown>,table=true){
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql.includes('to_regclass'))return {rows:[{links:'links',resources:'resources',facts:table?'facts':null}]};
  if(sql.includes('SELECT d.sourcing_contract_document_id')){expect(values).toEqual([order]);return {rows:[{sourcing_contract_document_id:'document',sourcing_case_id:'case',generated_at:generated}]};}
  if(sql.includes('SELECT production_order_id')){expect(values).toEqual(['case']);return {rows:[{production_order_id:order}]};}
  if(sql.includes('SELECT scenario_id')){expect(values).toEqual([order]);return {rows:scope?[{scenario_id:scope}]:[]};}
  if(sql.includes('FROM sourcing_contract_business_ready_facts'))return {rows:fact?[fact]:[]};
  throw new Error(`Unexpected history query: ${sql}`);
 });
 return {query} as never;
}
describe('contract first business-ready historical boundary',()=>{
 it.each([true,false])('keeps a legacy scene unknown rather than inventing its current time (fact table=%s)',async table=>{
  expect(await firstContractBusinessReady(history(scene,undefined,table),order)).toMatchObject({at:null,kind:'unknown'});
 });
 it.each([true,false])('preserves ordinary legacy PDF time without rewriting it (fact table=%s)',async table=>{
  expect(await firstContractBusinessReady(history(null,undefined,table),order)).toMatchObject({at:generated,kind:'legacy'});
 });
 it('accepts only the matching immutable original scope and business instant',async()=>{
  const fact={business_time:{now:generated,scenarioId:scene,revision:1},business_ready_at:generated,operation_event_id:'ready-audit'};
  expect(await firstContractBusinessReady(history(scene,fact),order)).toEqual({at:generated,kind:'business',evidence:'contract-business-ready:ready-audit'});
  await expect(firstContractBusinessReady(history(null,fact),order)).rejects.toMatchObject({code:'ACCEPTANCE_ISOLATION',statusCode:409});
  await expect(firstContractBusinessReady(history(scene,{...fact,business_ready_at:'2026-10-02T08:00:00.000Z'}),order)).rejects.toMatchObject({code:'ACCEPTANCE_ISOLATION'});
 });
});
