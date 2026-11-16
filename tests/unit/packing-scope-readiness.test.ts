import {expect,it} from 'vitest';
import {packingScopeReadiness,type PackingScopeReadinessInput} from '../../apps/api/src/production-platform/packing-scope-readiness.js';

const original: PackingScopeReadinessInput={observedAt:'2026-11-16T12:00:00Z',scope:'whole_po',scopeRef:'po:A',expectedQuantity:2,receivedQuantity:2,qualifiedQuantity:2,
 conditions:[{reference:'receipt:A1:qc:v1',complete:true,occurred:{precision:'instant',at:'2026-11-15T10:00:00.123Z'}},
  {reference:'receipt:A2:qc:v1',complete:true,occurred:{precision:'instant',at:'2026-11-15T11:00:00.456Z'}}]};

it('proves an explicit whole-PO convergence and retains exact time without pretending it is each receipt start',()=>{
 expect(packingScopeReadiness(original)).toMatchObject({scope:'whole_po',scopeRef:'po:A',state:'ready',ready:{precision:'instant',at:'2026-11-15T11:00:00.456Z'}});
 expect(packingScopeReadiness({...original,scope:'receipt_allocation',scopeRef:'receipt:A1',expectedQuantity:1,receivedQuantity:1,qualifiedQuantity:1,conditions:[original.conditions[0]!]}))
  .toMatchObject({scope:'receipt_allocation',ready:{precision:'instant',at:'2026-11-15T10:00:00.123Z'}});
});

it('waits for the actual required wash/rework condition instead of using the last QC as a substitute',()=>{
 const pending={reference:'receipt:A2:wash-inspection:v1',complete:false,occurred:{precision:'unknown'} as const};
 expect(packingScopeReadiness({...original,conditions:[...original.conditions,pending]})).toMatchObject({state:'not_ready',ready:{precision:'unknown'}});
 expect(packingScopeReadiness({...original,conditions:[...original.conditions,{...pending,complete:true,occurred:{precision:'instant',at:'2026-11-15T12:00:00.789Z'}}]}))
  .toMatchObject({state:'ready',ready:{precision:'instant',at:'2026-11-15T12:00:00.789Z'}});
});

it('keeps missing or date-only necessary times unknown and does not replace them with another condition',()=>{
 for(const occurred of [{precision:'unknown'} as const,{precision:'date' as const,date:'2026-11-15'},{precision:'instant' as const,at:'invalid'}]){
  expect(packingScopeReadiness({...original,conditions:[original.conditions[0]!,{...original.conditions[1]!,occurred}]}))
   .toMatchObject({state:'unknown',ready:{precision:'unknown'}});
 }
 expect(packingScopeReadiness({...original,conditions:[]})).toMatchObject({state:'unknown'});
});

it('never promotes cumulative packing or a partial qualified range into a proven ready scope',()=>{
 expect(packingScopeReadiness({...original,qualifiedQuantity:1})).toMatchObject({state:'not_ready'});
 expect(packingScopeReadiness({...original,receivedQuantity:null})).toMatchObject({state:'unknown'});
 expect(packingScopeReadiness({...original,qualifiedQuantity:3})).toMatchObject({state:'unknown'});
 expect(packingScopeReadiness({...original,expectedQuantity:0})).toMatchObject({state:'unknown'});
});
