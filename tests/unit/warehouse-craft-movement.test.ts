import {describe,expect,it} from 'vitest';
import {qualifyWarehouseCraftMovement} from '../../apps/api/src/production-platform/warehouse-craft-movement.js';

const now='2026-11-02T04:00:00Z',scope={orderId:'A',preparationId:'v2',stepRef:'step2'};
const original={...scope,occurredAt:'2026-11-01T04:00:00Z',factoryId:'F1',factId:'exact-send',
 quantities:[{lineId:'blue',remaining:50},{lineId:'green',remaining:25}]};
const motion={scope,sourceFactId:original.factId,factoryId:original.factoryId,occurredAt:now,kind:'return' as const,lines:[{lineId:'blue',quantity:30}]};
const inputs={motion,original,asOf:now,occupation:{...scope,sourceFactId:original.factId,lines:[{lineId:'blue',quantity:20}]}};

describe('exact warehouse craft movement',()=>{
 it('keeps twenty occupied pieces out of the ordinary movement and does not charge another PO',()=>{
  expect(qualifyWarehouseCraftMovement(inputs)).toEqual(motion.lines);
  expect(qualifyWarehouseCraftMovement({...inputs,motion:{...motion,lines:[{lineId:'blue',quantity:31}]}})).toBeNull();
  expect(qualifyWarehouseCraftMovement({...inputs,motion:{...motion,lines:[...motion.lines,{lineId:'green',quantity:25}]}})).toHaveLength(2);
  expect(qualifyWarehouseCraftMovement({...inputs,occupation:null})).toBeNull();
  expect(qualifyWarehouseCraftMovement({...inputs,occupation:{...inputs.occupation,sourceFactId:'another batch'}})).toBeNull();
 });
 it('rejects the wrong original factory, source, step, work version and chronology',()=>{
  for(const invalid of [{factoryId:'replacement factory'},{sourceFactId:null},{scope:{...scope,stepRef:'step1'}},
    {scope:{...scope,preparationId:'older'}},{occurredAt:'2026-11-03T04:00:00Z'},{occurredAt:'2026-10-31T04:00:00Z'}]){
   expect(qualifyWarehouseCraftMovement({...inputs,motion:{...motion,...invalid}})).toBeNull();
  }
 });
});
