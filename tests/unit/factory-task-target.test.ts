import {describe,it,expect} from 'vitest';
import {factoryTaskTarget,factoryTaskAction} from '../../apps/web/src/factory-task-target.js';
import {productionLineTarget} from '../../apps/web/src/production-line-target.js';
import {cuttingReturnPath} from '../../apps/web/src/cutting-query.js';
const id='22222222-2222-4222-8222-222222222222';
describe('original cutting and factory task destinations',()=>{
 it('retains stable PO and actual action without accepting ambiguous or invalid targets',()=>{
  expect(factoryTaskTarget(`?factory=${id}&factoryAction=qc&line=${id}`)).toEqual({action:'qc',lineId:id,error:null});
  for(const search of ['?factoryAction=qc&factoryAction=dispatch','?factoryAction=finance','?line=unknown',`?line=${id}&line=${id}`])expect(factoryTaskTarget(search).error).toBeTruthy();
  expect(factoryTaskAction('warehouse_dispatch')).toBe('dispatch');expect(factoryTaskAction('bulk_qc')).toBe('qc');expect(factoryTaskAction('process_logistics')).toBe('logistics');expect(factoryTaskAction('factory_material_count')).toBe('followup');
 });
 it('resolves production PO by persisted child mapping and refuses guesses',()=>{const dates=[{lineId:id,position:2,poNumber:'TEST',color:'黑',customerWarehouseArrivalDate:null,factoryDeliveryDate:null,sampleTargetDate:null}];expect(productionLineTarget(`?line=${id}`,dates).position).toBe(2);expect(productionLineTarget(`?line=${id}`,undefined).error).toBeTruthy();expect(productionLineTarget(`?line=${id}&line=${id}`,dates).error).toBeTruthy();});
 it('returns cutting records to the exact mother while preserving filtered original lists and rejecting external returns',()=>{
  const target=`/ui/digital-cockpit?selected=${id}&page=2&search=TEST`;
  expect(cuttingReturnPath('?returnTo='+encodeURIComponent(target))).toContain(`selected=${id}`);
  expect(cuttingReturnPath('?returnTo='+encodeURIComponent('/acceptance'+target),'/acceptance/')).toContain(`/ui/digital-cockpit?`);
  expect(cuttingReturnPath('?returnTo='+encodeURIComponent('/acceptance'+target),'/acceptance/')).not.toContain('/acceptance/');
  expect(cuttingReturnPath('?returnTo='+encodeURIComponent('/ui/cutting?q=TEST&page=2'))).toBe('/ui/cutting?q=TEST&page=2');
  expect(cuttingReturnPath('?returnTo=https://external.invalid')).toBe('/ui/cutting');
  expect(cuttingReturnPath('?returnTo='+encodeURIComponent('/ui/digital-cockpit?selected=bad'))).toBe('/ui/cutting');
 });
});
