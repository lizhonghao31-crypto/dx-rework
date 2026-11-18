import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {bulkWashingWindowReference,type BulkWashingSheet,type BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import {JourneyReturnContextSchema,type JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import {factoryTaskTarget} from '../../apps/web/src/factory-task-target.js';
import {selectCockpitWashingWindow,selectWashingWindow,washingWindowChoices,washingWindowFacts,washingWindowDomId} from '../../apps/web/src/washing-window-target.js';
import {journeyWashingWindowRecord} from '../../apps/api/src/production-platform/journey-washing-window-record.js';
import {digitalDetailReturnUrl,productionWorkspaceDomainHref} from '../../apps/web/src/digital-detail-route.js';
import {JourneyTimingWindows} from '../../apps/web/src/journey-sla-details.js';

const order='11111111-1111-4111-8111-111111111111',line='22222222-2222-4222-8222-222222222222',foreign='33333333-3333-4333-8333-333333333333',at='2026-11-17T08:00:00.000Z';
function scope(mode:'factory'|'after_receipt'='after_receipt'):BulkWashingScopeView{
 const scopeId=mode==='factory'?`factory:${order}:${foreign}:${line}`:`receipt:${foreign}`;
 const facts:BulkWashingScopeView['facts']=[];
 for(const i of [1,2]){
  const common={scopeId,quantityVersion:'TEST-q1',occurredAt:at,recordedAt:at,operator:'TEST native worker',note:'TEST original event',voided:false,quantity:1};
  facts.push(mode==='factory'?{...common,id:'start'+i,kind:'factory_start'}:{...common,id:'start'+i,kind:'send'});
  facts.push(mode==='factory'?{...common,id:'return'+i,kind:'factory_complete',startId:'start'+i}:{...common,id:'return'+i,kind:'return',sendId:'start'+i});
  facts.push({...common,id:'inspection'+i,kind:'inspection',completionId:'return'+i,qualifiedQuantity:1});
 }
 return {scopeId,lineId:line,factoryDecisionId:mode==='factory'?foreign:null,quantityVersion:'TEST-q1',quantity:2,planId:'TEST-frozen-plan',mode,label:'TEST exact PO batch',revision:6,receivedAt:at,availableAt:at,canLogistics:true,canInspect:true,canCorrect:true,
  windows:[1,2].flatMap(i=>[{id:'start'+i,kind:'washing' as const,state:'completed' as const,startedAt:at,dueAt:at,completedAt:at,minutes:60,overdueMinutes:0},{id:'return'+i+':qc',kind:'inspection' as const,state:'completed' as const,startedAt:at,dueAt:at,completedAt:at,minutes:60,overdueMinutes:0}]),
  ledger:{applicable:true,conflict:false,reasons:[],sent:2,washed:2,qualified:2,remaining:0,complete:true,completedAt:at,sendable:0},facts};
}
const url=(reference:string)=>'/ui/digital-production?'+new URLSearchParams({factory:order,factoryAction:'washing',line,washingWindow:reference});
const cockpitNode=(instanceId:string,windows:NonNullable<JourneyNode['nativeWindows']>):JourneyNode=>({key:'bulk_return_washing',instanceId,label:'同一模板原洗水',stage:'receiving',state:'completed',current:true,round:null,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:at,actualQuality:'verified',enteredAt:at,sla:'finished',completionResult:'on_time',overdueSeconds:0,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,nativeWindows:windows});

describe('exact authorized native washing windows',()=>{
 it.each(['factory','after_receipt'] as const)('resolves all four %s windows and associated original event pointers without borrowing a sibling',mode=>{
  const original=scope(mode),sheet:BulkWashingSheet={orderId:order,scopes:[original]},before=structuredClone(sheet),refs=[];
  for(const window of original.windows){
   const reference=bulkWashingWindowReference(original.scopeId,window.id),parsed=factoryTaskTarget(new URL(url(reference),'https://TEST.invalid').search);
   expect(parsed).toMatchObject({action:'washing',lineId:line,factoryId:order,washingWindow:reference,error:null});
   const selected=selectWashingWindow(sheet,order,{lineId:parsed.lineId,reference:parsed.washingWindow!,factoryId:parsed.factoryId});
   expect(selected.error).toBeNull();expect(selected.scope).toBe(original);expect(selected.window).toBe(window);
   const batch=window.id.includes('1')?'1':'2';expect(washingWindowFacts(original,window).map(fact=>fact.id)).toEqual(['start'+batch,'return'+batch,'inspection'+batch]);refs.push(reference);
  }
  expect(new Set(refs).size).toBe(4);expect(sheet).toEqual(before);
 });
 it('retains the old exact reference after unrelated revision/new batches and preserves authorized withdrawn history',()=>{
  const original=scope(),reference=bulkWashingWindowReference(original.scopeId,'start1'),sheet={orderId:order,scopes:[original]};original.revision=100;
  original.windows.unshift({...original.windows[0]!,id:'new-start',state:'active',completedAt:null});
  expect(selectWashingWindow(sheet,order,{lineId:line,reference}).window?.id).toBe('start1');
  const prior=original.windows.find(window=>window.id==='start1')!;prior.state='voided';original.facts[0]!.voided=true;
  expect(selectWashingWindow(sheet,order,{lineId:line,reference}).window?.state).toBe('voided');expect(washingWindowFacts(original,prior)[0]!.voided).toBe(true);
 });
 it('rejects foreign order/PO/scope, unavailable identity and duplicate native windows without a summary fallback',()=>{
  const original=scope(),sheet={orderId:order,scopes:[original]},reference=bulkWashingWindowReference(original.scopeId,'start1');
  for(const target of [{lineId:line,reference,factoryId:foreign},{lineId:foreign,reference},{lineId:null,reference},{lineId:line,reference:bulkWashingWindowReference('receipt:OTHER','start1')},{lineId:line,reference:bulkWashingWindowReference(original.scopeId,'missing')}])expect(selectWashingWindow(sheet,order,target)).toMatchObject({scope:null,window:null,error:expect.any(String)});
  original.windows.push({...original.windows[0]!});expect(selectWashingWindow(sheet,order,{lineId:line,reference}).error).toContain('不唯一');
  expect(selectWashingWindow(sheet,order,{lineId:line,reference:null})).toEqual({error:null,scope:null,window:null});
 });
 it('validates complete URL combinations, duplicates and encoded controls instead of opening another action',()=>{
  const good=url('washing:receipt:TEST:start1');
  for(const path of [good+'&washingWindow=washing:OTHER:x',good+'&factory='+order,good+'&line='+line,good+'&factoryAction=qc',good.replace('factoryAction=washing','factoryAction=qc'),good.replace('line='+line,'line=bad'),good.replace('factory='+order+'&',''),good.replace('&line='+line,''),good.replace('washingWindow=washing%3Areceipt%3ATEST%3Astart1','washingWindow=washing%3A%00x')]){
   expect(factoryTaskTarget(new URL(path,'https://TEST.invalid').search).error,path).toBeTruthy();expect(digitalDetailReturnUrl(path,'/'),path).toBeNull();
  }
 });
 it.each(['/','/acceptance/'])('preserves exact window and original cockpit context across a budget second hop, base=%s',base=>{
  const reference=bulkWashingWindowReference(scope('factory').scopeId,'return1:qc'),context=JourneyReturnContextSchema.parse({selected:order,page:2,focus:'washing-work:TEST',row:'washing-work:TEST',milestone:'TEST-shipment',materialFocus:'washing-window:'+reference});
  const back='/ui/digital-cockpit?'+new URLSearchParams(Object.entries(context).map(([key,value])=>[key,String(value)]));
  const parent=url(reference)+'&'+new URLSearchParams({returnTo:back}),accepted=digitalDetailReturnUrl(parent,base)!;
  expect(accepted).toBeTruthy();expect(new URL(accepted,'https://TEST.invalid').searchParams.get('washingWindow')).toBe(reference);
  const href=productionWorkspaceDomainHref('/ui/digital-production?budget='+order,new URL(accepted,'https://TEST.invalid').search,base,base+'ui/digital-production');
  const returned=new URL(href,'https://TEST.invalid').searchParams.get('returnTo')!;expect(returned).toBe(accepted);expect(new URL(new URL(returned,'https://TEST.invalid').searchParams.get('returnTo')!,'https://TEST.invalid').searchParams.get('materialFocus')).toBe('washing-window:'+reference);
 });
 it('renders four original read-only links with full references and rejects missing or inconsistent native identity',()=>{
  const row=scope('factory'),context=JourneyReturnContextSchema.parse({selected:order}),windows=row.windows.map(window=>({evidence:bulkWashingWindowReference(row.scopeId,window.id),scopeLabel:'TEST',startedAt:at,deadline:at,warningAt:null,completedAt:at,complete:true,record:journeyWashingWindowRecord(order,line,bulkWashingWindowReference(row.scopeId,window.id),{scopeId:row.scopeId,windowId:window.id})}));
  const html=renderToStaticMarkup(createElement(JourneyTimingWindows,{timing:{windows},context}));expect((html.match(/查看本窗口记录/g)??[])).toHaveLength(4);
  for(const window of row.windows)expect(html).toContain(encodeURIComponent(bulkWashingWindowReference(row.scopeId,window.id)));
  expect(journeyWashingWindowRecord(order,line,'washing:OTHER:x',{scopeId:row.scopeId,windowId:'start1'})).toBeUndefined();expect(journeyWashingWindowRecord(order,line,'washing:OTHER:x',undefined)).toBeUndefined();expect(journeyWashingWindowRecord(order,null,'washing:OTHER:x',{scopeId:'OTHER',windowId:'x'})).toBeUndefined();
 });
 it('retains a legal long opaque reference in the return focus and distinct DOM identity',()=>{
  const reference=bulkWashingWindowReference('factory:'+('a'.repeat(292)),'11111111-1111-4111-8111-111111111111:qc');
  expect(factoryTaskTarget(new URL(url(reference),'https://TEST.invalid').search).washingWindow).toBe(reference);
  expect(JourneyReturnContextSchema.safeParse({selected:order,materialFocus:'washing-window:'+reference}).success).toBe(true);expect(washingWindowDomId(reference)).not.toBe(washingWindowDomId(reference+':other'));
 });
 it('keeps six native windows distinct despite common template, PO and null round, and selects every exact original instance',()=>{
  const windows=[1,2,3].flatMap(index=>['start'+index,'return'+index+':qc']).map(id=>({evidence:bulkWashingWindowReference(scope().scopeId,id),scopeLabel:'同一PO原洗水批次',startedAt:at,deadline:at,warningAt:null,completedAt:at,complete:true,record:journeyWashingWindowRecord(order,line,bulkWashingWindowReference(scope().scopeId,id),{scopeId:scope().scopeId,windowId:id})}));
  const first=cockpitNode('original-washing',windows.filter((_,index)=>index%2===0)),second=cockpitNode('original-inspection',windows.filter((_,index)=>index%2===1)),nodes=[first,second],before=structuredClone(nodes);
  expect(washingWindowChoices(windows).map(row=>row.evidence).sort()).toEqual(windows.map(row=>row.evidence).sort());
  for(const node of nodes)for(const window of node.nativeWindows!){
   const focus='washing-window:'+window.evidence;
   expect(selectCockpitWashingWindow(nodes,node.instanceId,focus)).toEqual({reference:window.evidence,node,error:null});
   const html=renderToStaticMarkup(createElement(JourneyTimingWindows,{timing:{windows:node.nativeWindows!},context:JourneyReturnContextSchema.parse({selected:order,focus:node.instanceId,materialFocus:focus}),onNavigate:()=>({})}));
   expect((html.match(/aria-pressed="true"/g)??[])).toHaveLength(1);expect((html.match(/选中本窗口/g)??[])).toHaveLength(3);expect(html).toContain('data-washing-choice="'+window.evidence+'" aria-current="true"');
  }
  expect(nodes).toEqual(before);
 });
 it('never falls back from an explicit missing, unauthorized, wrong-instance or ambiguous cockpit window',()=>{
  const reference=bulkWashingWindowReference(scope().scopeId,'start1'),window={evidence:reference,scopeLabel:'TEST',startedAt:at,deadline:at,warningAt:null,completedAt:at,complete:true,record:journeyWashingWindowRecord(order,line,reference,{scopeId:scope().scopeId,windowId:'start1'})},node=cockpitNode('TEST-native-instance',[window]);
  for(const [nodes,id,focus] of [
   [[node],'OTHER','washing-window:'+reference],[[node],node.instanceId,'washing-window:washing:FOREIGN:missing'],
   [[{...node,state:'unavailable' as const,unavailableReason:'permission' as const}],node.instanceId,'washing-window:'+reference],
   [[],node.instanceId,'washing-window:'+reference],[[node,{...node,instanceId:'OTHER'}],undefined,'washing-window:'+reference],
   [[node],node.instanceId,'washing-window:'],[[node],node.instanceId,'washing-window:\u0000'],
  ] as const)expect(selectCockpitWashingWindow(nodes,id,focus)).toMatchObject({node:null,error:expect.any(String)});
  expect(selectCockpitWashingWindow([node],node.instanceId,'primary')).toEqual({reference:null,node:null,error:null});
  expect(selectCockpitWashingWindow([node,{...node,instanceId:'rewash-work'}],node.instanceId,'washing-window:'+reference).node).toBe(node);
 });
 it('coalesces only identical evidence representations and blocks conflicting duplicate R/D/A or record targets',()=>{
  const reference=bulkWashingWindowReference(scope().scopeId,'start1'),window={evidence:reference,scopeLabel:'TEST',startedAt:at,deadline:at,warningAt:null,completedAt:at,complete:true,record:journeyWashingWindowRecord(order,line,reference,{scopeId:scope().scopeId,windowId:'start1'})};
  expect(washingWindowChoices([window,structuredClone(window)])).toEqual([{evidence:reference,window}]);
  for(const changed of [{...window,deadline:'2026-11-17T09:00:00.000Z'},{...window,record:{...window.record!,lineId:foreign}}]){
   expect(washingWindowChoices([window,changed])).toEqual([{evidence:reference,window:null}]);
   expect(selectCockpitWashingWindow([cockpitNode('TEST',[window,changed])],'TEST','washing-window:'+reference)).toMatchObject({node:null,error:expect.any(String)});
   const html=renderToStaticMarkup(createElement(JourneyTimingWindows,{timing:{windows:[window,changed]},context:{}}));expect(html).toContain('原窗口资料冲突');expect(html).not.toContain('查看本窗口记录');
  }
 });
});
