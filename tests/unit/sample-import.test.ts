import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {validateSampleImport} from '../../apps/api/src/samples/sample-import-service.js';
import {inventorySampleSource,sampleSourceHash} from '../../apps/api/src/samples/sample-migration.js';
import type {SampleImportPlan} from '../../packages/contracts/src/index.js';
function fixture(){
 const user=randomUUID(),record={id:'old-1',sampleCode:'YI-202001-0001',status:'IN_STOCK',brand:'测试',styleName:'样衣',color:'蓝',department:'设计',purchaser:'同名员工',purchaseDate:'2020-01-01',purchasePrice:'123.45',borrowHistory:[],disposalHistory:[] as Record<string,unknown>[]};
 const source={updatedAt:'2020-01-01T00:00:00Z',samples:[record],logs:[],borrowRequests:[]};
 const plan:SampleImportPlan={sourceHash:sampleSourceHash(source),reason:'固定测试',items:[{legacyId:record.id,sourceHash:sampleSourceHash(record),status:'in_stock',purchaserUserId:user,holderUserId:null,holderName:null,borrowedAt:null,purpose:null,storageLocation:'A01',archivedFromStatus:null,archiveReason:null,normalizationReason:'原状态保留',custody:[],requests:[]}],objects:[],decisions:inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'历史缺票明确登记；固定员工 ID 已确认'}))};
 return {source,record,plan,user};
}
describe('explicit migration normalization and unresolved evidence',()=>{
 it('does not infer identity from the same display name or waive missing receipt evidence',()=>{
  const {source,plan}=fixture();expect(validateSampleImport(source,plan).plan).toEqual(plan);
  expect(()=>validateSampleImport(source,{...plan,items:[{...plan.items[0],purchaserUserId:'同名员工'}]})).toThrow();
  expect(()=>validateSampleImport(source,{...plan,decisions:plan.decisions.filter(i=>i.code!=='MISSING_RECEIPT')})).toThrow();
 });
 it('requires explicit typed history for DISPOSED and preserves actual sale money',()=>{
  const {source,record,plan,user}=fixture(),old={id:'d1',type:'SOLD',amount:'20.35'};record.status='DISPOSED';record.disposalHistory=[old];plan.sourceHash=sampleSourceHash(source);const item=plan.items[0]!;item.sourceHash=sampleSourceHash(record);item.status='sold';item.storageLocation=null;
  plan.decisions=inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'原出售记录明确归一为已出售'}));
  expect(()=>validateSampleImport(source,plan)).toThrow();
  item.requests=[{legacyId:'d1',sourceHash:sampleSourceHash(old),type:'sale',status:'completed',fromStatus:'in_stock',requestedBy:user,requestedFor:null,purpose:null,reason:'原出售记录',createdAt:'2020-01-01T01:00:00Z',resolvedBy:user,resolvedAt:'2020-01-01T02:00:00Z',resolutionReason:null,proofObjectKeys:[],disposal:{recipient:'买方',responsibleUserId:null,proposedAmount:'20.35',finalAmount:'20.35',approvedBy:user,approvedAt:'2020-01-01T02:00:00Z',paidBy:null,paidAt:null}}];
  expect(validateSampleImport(source,plan).plan.items[0]!.status).toBe('sold');item.requests[0]!.disposal!.finalAmount='20.36';expect(()=>validateSampleImport(source,plan)).toThrow();
 });
 it('rejects changed source, duplicate rows and silent removal of referenced objects',()=>{
  const {source,plan}=fixture();expect(()=>validateSampleImport({...source,updatedAt:'2020-01-02T00:00:00Z'},plan)).toThrow();expect(()=>validateSampleImport(source,{...plan,items:[...plan.items,...plan.items]})).toThrow();
  const changed={...source,samples:[{...source.samples[0],receiptImages:[{objectKey:'daxing-sample/receipt/original.png'}]}]};plan.sourceHash=sampleSourceHash(changed);plan.items[0]!.sourceHash=sampleSourceHash(changed.samples[0]);plan.decisions=inventorySampleSource(changed).report.issues.map(i=>({...i,conclusion:'已核实'}));expect(()=>validateSampleImport(changed,plan)).toThrow();
 });
});
