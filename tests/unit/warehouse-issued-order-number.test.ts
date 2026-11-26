import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {describe,expect,it,vi} from 'vitest';
import {issuedOrderNumber,issuedOrderNumbers} from '../../apps/api/src/production-platform/order-number-repository.js';

describe('authorized warehouse numbered revisions',()=>{
 it.each([1,15,50])('queries %i assigned revision roots in one round trip without changing candidate order',async count=>{
  const originals=Array.from({length:count},(_,index)=>({
   source_id:randomUUID(),root_id:randomUUID(),design_style_no:`DEV-ROOT-${index+1}`,
  }));
  const candidates=originals.map(row=>({source:{source_id:row.source_id,design_style_no:'原复版',workbench_number_root_id:row.root_id},order:null}));
  const query=vi.fn(async()=>({rows:[...originals].reverse()}));
  expect(await issuedOrderNumbers({query:query as unknown as PoolClient['query']},candidates)).toEqual(originals.map(row=>row.design_style_no));
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('revision.root_source_id=target.root_id'),[
   JSON.stringify(originals.map(({source_id,root_id})=>({source_id,root_id}))),
  ]);
 });

 it('never fetches root numbers for a formal mismatch and requires the exact original revision relation',async()=>{
  const root=randomUUID(),source={source_id:randomUUID(),design_style_no:'REV',workbench_number_root_id:root};
  const generated={source_id:randomUUID(),design_style_no:'DEV-ONE',workbench_generated_number:true};
  const query=vi.fn(async()=>({rows:[{source_id:source.source_id,root_id:randomUUID(),design_style_no:'UNRELATED'}]}));
  const db={query:query as unknown as PoolClient['query']};
  expect(await issuedOrderNumber(db,generated,{source_id:generated.source_id,design_style_no:'DEV-ONE'})).toBe('DEV-ONE');
  expect(await issuedOrderNumber(db,source,{source_id:source.source_id,design_style_no:'REV'})).toBeNull();
  expect(query).not.toHaveBeenCalled();
  expect(await issuedOrderNumbers(db,[{source,order:null},{source:null,order:null}])).toEqual([null,null]);
  expect(query).toHaveBeenCalledTimes(1);
 });
});
