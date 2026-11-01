import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PreparationMaterialRecordSchema} from '@dx-rework/contracts/production-readiness';
const input=()=>({kind:'fabric_receipt',scopeRef:'whole',expectedVersion:0,state:'partial',occurredAt:'2026-11-01T00:00:00+08:00',note:'TEST actual partial receipt',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null});
describe('native preparation input boundaries',()=>{
 it('keeps a partial real occurrence distinct from an unknown or withdrawn completion',()=>{
  expect(PreparationMaterialRecordSchema.parse(input()).state).toBe('partial');
  for(const state of ['unknown','withdrawn']){expect(PreparationMaterialRecordSchema.safeParse({...input(),state}).success).toBe(false);expect(PreparationMaterialRecordSchema.safeParse({...input(),state,occurredAt:null}).success).toBe(true);}
 });
 it('rejects fractional physical labels, repeated quantity rows and non-finite values',()=>{
  const q={lineId:randomUUID(),materialId:null,name:'TEST款号唛',quantity:10,unit:'枚'},row={...input(),kind:'style_label_ready',state:'ready',quantities:[q]};
  expect(PreparationMaterialRecordSchema.safeParse(row).success).toBe(true);
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[{...q,quantity:0.5}]}).success).toBe(false);
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[q,q]}).success).toBe(false);
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[{...q,quantity:Infinity}]}).success).toBe(false);
 });
 it('rejects client-authored system validity, permissions, material fingerprints and audit fields',()=>{
  for(const extra of [{valid:true},{canRecord:['fabric_receipt']},{materialBasis:'fake'},{recordedBy:randomUUID()},{recordedAt:'2026-11-01T00:00:00Z'}])expect(PreparationMaterialRecordSchema.safeParse({...input(),...extra}).success).toBe(false);
 });
});
