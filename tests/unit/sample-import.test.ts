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
 it('preserves legacy INITIAL_BORROW as initial custody',()=>{
  const f=fixture(),h={id:'h1',type:'INITIAL_BORROW',borrower:'同名员工',borrowedAt:'2020-01-01T01:00:00Z',purpose:'采购后直接开发/打板'};
  const source={...f.source,samples:[{...f.record,status:'BORROWED',currentHolder:h.borrower,borrowHistory:[h]}]},plan=f.plan,item=plan.items[0]!;
  plan.sourceHash=sampleSourceHash(source);item.sourceHash=sampleSourceHash(source.samples[0]);item.status='borrowed';item.holderUserId=f.user;item.holderName=h.borrower;item.borrowedAt=h.borrowedAt;item.purpose=h.purpose;item.storageLocation=null;
  item.custody=[{legacyId:h.id,sourceHash:sampleSourceHash(h),holderUserId:f.user,holderName:h.borrower,department:'设计',purpose:h.purpose,borrowedAt:h.borrowedAt,returnedAt:null,disposedAt:null,initialCustody:false,requestedBy:f.user,confirmedBy:null}];
  plan.decisions=inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'固定映射及历史缺票已登记'}));expect(()=>validateSampleImport(source,plan)).toThrow();
  item.custody[0]!.initialCustody=true;expect(validateSampleImport(source,plan).plan.items[0]!.custody[0]!.initialCustody).toBe(true);
 });
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
  item.requests[0]!.disposal!.finalAmount='20.35';
  const h={id:'held-1',type:'INITIAL_BORROW',borrower:'同名员工',borrowedAt:'2020-01-01T01:00:00Z',returnedAt:null,purpose:'采购后直接开发/打板'};
  const staleSource={...source,samples:[{...record,currentHolder:h.borrower,borrowHistory:[h]}]};plan.sourceHash=sampleSourceHash(staleSource);item.sourceHash=sampleSourceHash(staleSource.samples[0]);item.holderUserId=user;item.holderName=h.borrower;item.borrowedAt=h.borrowedAt;item.purpose=h.purpose;
  item.custody=[{legacyId:h.id,sourceHash:sampleSourceHash(h),holderUserId:user,holderName:h.borrower,department:'设计',purpose:h.purpose,borrowedAt:h.borrowedAt,returnedAt:null,disposedAt:null,initialCustody:true,requestedBy:user,confirmedBy:null}];plan.decisions=inventorySampleSource(staleSource).report.issues.map(i=>({...i,conclusion:'保留旧原值并明确结束已处置持有责任'}));
  expect(()=>validateSampleImport(staleSource,plan)).toThrow();item.holderUserId=null;item.holderName=null;item.borrowedAt=null;item.purpose=null;item.custody[0]!.disposedAt='2020-01-01T02:00:00Z';
  expect(validateSampleImport(staleSource,plan).plan.items[0]!.holderUserId).toBeNull();
 });
 it('binds every proof to the exact source request, rejecting cross-sample keys and omissions',()=>{
  const f=fixture(),key1='daxing-sample/proof/one.png',key2='daxing-sample/proof/two.png';
  const originals=[{...f.record,status:'PENDING_BORROW'},{...f.record,id:'old-2',sampleCode:'YI-202001-0002',status:'PENDING_BORROW'}];
  const requests=originals.map((s,n)=>({id:`request-${n}`,sampleId:s.id,type:'BORROW',photos:[{objectKey:n===0?key1:key2}]}));
  const source={...f.source,samples:originals,borrowRequests:requests},plan=f.plan;plan.sourceHash=sampleSourceHash(source);
  const base=plan.items[0]!;plan.items=originals.map((s,n)=>({...base,legacyId:s.id,sourceHash:sampleSourceHash(s),status:'borrow_pending',requests:[{legacyId:requests[n]!.id,sourceHash:sampleSourceHash(requests[n]),type:'borrow',status:'pending',fromStatus:'in_stock',requestedBy:f.user,requestedFor:f.user,purpose:'开发',reason:'',createdAt:'2020-01-01T01:00:00Z',resolvedBy:null,resolvedAt:null,resolutionReason:null,disposal:null,proofObjectKeys:[n===0?key1:key2]}]}));
  plan.objects=[key1,key2].map(objectKey=>({objectKey,attachmentId:randomUUID(),sha256:'a'.repeat(64),sizeBytes:10}));plan.decisions=inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'固定映射及缺票事实已登记'}));
  expect(validateSampleImport(source,plan).plan.items).toHaveLength(2);plan.items[0]!.requests[0]!.proofObjectKeys=[key2];expect(()=>validateSampleImport(source,plan)).toThrow();
  plan.items[0]!.requests[0]!.proofObjectKeys=[];expect(()=>validateSampleImport(source,plan)).toThrow();
  const history={id:'prior-borrow',type:'BORROW',borrower:'同名员工',borrowedAt:'2020-01-01T02:00:00Z',returnedAt:'2020-01-01T03:00:00Z',purpose:'之前开发'};
  (source.samples[0] as Record<string,unknown>).borrowHistory=[history];source.samples[1]!.status='IN_STOCK';source.updatedAt='2020-01-02T01:00:00Z';source.borrowRequests[1]!.sampleId=source.samples[0]!.id;
  const first=plan.items[0]!,second=plan.items[1]!,previous={...second.requests[0]!,sourceHash:sampleSourceHash(source.borrowRequests[1]),status:'completed' as const,resolvedBy:f.user,resolvedAt:'2020-01-01T02:00:00Z'};
  first.requests[0]!.proofObjectKeys=[key1];first.requests[0]!.createdAt='2020-01-02T01:00:00Z';first.requests.push(previous);second.requests=[];second.status='in_stock';
  first.custody=[{legacyId:history.id,sourceHash:sampleSourceHash(history),holderUserId:f.user,holderName:history.borrower,department:'设计',purpose:history.purpose,borrowedAt:history.borrowedAt,returnedAt:history.returnedAt,disposedAt:null,initialCustody:false,requestedBy:f.user,confirmedBy:f.user}];
  plan.sourceHash=sampleSourceHash(source);first.sourceHash=sampleSourceHash(source.samples[0]);second.sourceHash=sampleSourceHash(source.samples[1]);plan.decisions=inventorySampleSource(source).report.issues.map(i=>({...i,conclusion:'固定映射及缺票事实已登记'}));
  expect(validateSampleImport(source,plan).plan.items[0]!.requests).toHaveLength(2);first.requests[0]!.proofObjectKeys=[key2];expect(()=>validateSampleImport(source,plan)).toThrow();
 });
 it('rejects changed source, duplicate rows and silent removal of referenced objects',()=>{
  const {source,plan}=fixture();expect(()=>validateSampleImport({...source,updatedAt:'2020-01-02T00:00:00Z'},plan)).toThrow();expect(()=>validateSampleImport(source,{...plan,items:[...plan.items,...plan.items]})).toThrow();
  const changed={...source,samples:[{...source.samples[0],receiptImages:[{objectKey:'daxing-sample/receipt/original.png'}]}]};plan.sourceHash=sampleSourceHash(changed);plan.items[0]!.sourceHash=sampleSourceHash(changed.samples[0]);plan.decisions=inventorySampleSource(changed).report.issues.map(i=>({...i,conclusion:'已核实'}));expect(()=>validateSampleImport(changed,plan)).toThrow();
 });
});
