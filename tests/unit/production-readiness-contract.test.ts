import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PreparationWindows} from '../../apps/web/src/production-readiness-panel.js';
import type {ProductionReadinessState} from '@dx-rework/contracts/production-readiness';
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
  for(const unit of ['箱','包','米'])expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[q,{...q,name:'TEST different batch',unit}]}).success).toBe(false);
  expect(PreparationMaterialRecordSchema.parse({...row,quantities:[{...q,unit:'件'}]}).quantities[0]!.unit).toBe('枚');
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[q,{...q,unit:'个'}]}).success).toBe(false);
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[{...q,quantity:0.5}]}).success).toBe(false);
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[q,q]}).success).toBe(false);
  expect(PreparationMaterialRecordSchema.safeParse({...row,quantities:[{...q,quantity:Infinity}]}).success).toBe(false);
 });
 it('rejects client-authored system validity, permissions, material fingerprints and audit fields',()=>{
  for(const extra of [{valid:true},{canRecord:['fabric_receipt']},{materialBasis:'fake'},{recordedBy:randomUUID()},{recordedAt:'2026-11-01T00:00:00Z'}])expect(PreparationMaterialRecordSchema.safeParse({...input(),...extra}).success).toBe(false);
 });
});

it('Acceptance PR02 labels the original independent frozen instruction windows instead of hard-coded 24 hours',()=>{
 const window={startedAt:null,dueAt:null,completedAt:null,reason:null,status:'waiting' as const};
 const state={enrolled:true,draftWindow:{...window,minutes:1440},finalWindow:{...window,minutes:4320}} as ProductionReadinessState;
 const html=renderToStaticMarkup(createElement(PreparationWindows,{state}));
 expect(html).toContain('制单草稿 · 到仓后1天');expect(html).toContain('正式制单 · 前提齐后3天');expect(html).not.toContain('24小时');
 state.finalWindow.minutes=null;expect(renderToStaticMarkup(createElement(PreparationWindows,{state}))).toContain('前提齐后用时待补');
});
