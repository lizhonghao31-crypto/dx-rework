import {expect,it} from 'vitest';
import {SERIES_MILESTONE_OFFSETS} from '@dx-rework/contracts/digital-series-plan';
import type {OrderTimeWashingReworkPlan} from '@dx-rework/contracts/order-time-washing-rework';
import {assertOrderTimeRewashInput,type OrderTimeInput,type StoredOrderTimePlan} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {attachWashingReworkInput,preparedStoredRewash} from '../../apps/api/src/production-platform/order-time-washing-rework.js';
import {assertWashingReworkBinding} from '../../apps/api/src/production-platform/bulk-washing-rework-binding.js';
import type {BulkWashingCommand,BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at=(hour:number)=>new Date(Date.parse('2026-11-10T00:00:00.000Z')+hour*3600000).toISOString();
function fixture(){
 const policy={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
 const row:OrderTimeWashingReworkPlan={intentId:id(1),orderId:id(2),lineId:id(3),scopeId:'receipt:'+id(4),factoryDecisionId:null,quantityVersion:'TEST qty1',
  inspectionId:id(5),quantity:2,planId:id(6),round:1,inspectionAt:at(1),arrangement:{mode:'after_receipt',reference:'TEST original',revision:1,accounting:'additional',washing:policy,inspection:policy},introducedAt:null,introducedEventRef:null};
 const goal={precision:'date' as const,value:'2026-11-20',source:'TEST original client'};
 const input:OrderTimeInput={version:'order-time-input-v1',plan:{version:'order-time-plan-v1',company:{version:'order-time-standard-v1',reference:'TEST frozen',revision:1,nodes:{},stageBufferMinutes:0,framework:{version:'time-framework-company-v1',milestoneOffsets:SERIES_MILESTONE_OFFSETS}},overrides:{},revision:1},
  work:[{id:'TEST original',parameterKey:'budget',stage:3,dependsOn:[]}],scopes:[{scopeRef:'po:'+row.lineId,lineId:row.lineId,terminalIds:['TEST original'],customerGoalIds:['TEST original'],customerGoal:goal,goals:{'TEST original':goal}}],
  route:{complete:true,missing:[]},frameworkContext:{route:'B',acceptedAt:{precision:'instant',value:at(0),source:'TEST original'},notBefore:{},progress:{}}};
 const bounds=attachWashingReworkInput(input,[row]);Object.assign(input.frameworkContext!.notBefore,bounds);
 return {input,row:input.rewashing![0]!,resource:{kind:'order' as const,id:row.orderId}};
}

it('binds the versioned input to exact work identities and the same PO delivery, leaving original work intact',()=>{
 const {input,row,resource}=fixture(),prepared=preparedStoredRewash(row);
 expect(()=>assertOrderTimeRewashInput(input,resource,false)).not.toThrow();
 expect(input.version).toBe('order-time-input-rewash-v1');expect(input.work[0]!.id).toBe('TEST original');
 expect(input.scopes[0]!.terminalIds).toEqual(['TEST original',prepared.requiredForDelivery]);
 expect(()=>attachWashingReworkInput(input,[row])).toThrow('身份重复');
 expect(()=>assertOrderTimeRewashInput(input,resource,true)).toThrow('生效来源');
 row.introducedAt=at(2);row.introducedEventRef='audit_events:'+id(7);
 expect(()=>assertOrderTimeRewashInput(input,resource,true)).not.toThrow();
});

it('rejects mixed old/new formats, hidden work changes and another order or PO instead of ignoring metadata',()=>{
 const {input,resource}=fixture();
 const wrongVersion=structuredClone(input);wrongVersion.version='order-time-input-v1';expect(()=>assertOrderTimeRewashInput(wrongVersion,resource,false)).toThrow('格式版本');
 const noRows=structuredClone(input);noRows.rewashing=[];expect(()=>assertOrderTimeRewashInput(noRows,resource,false)).toThrow('格式版本');
 const disguised=structuredClone(input);disguised.version='order-time-input-v1';delete disguised.rewashing;expect(()=>assertOrderTimeRewashInput(disguised,resource,false)).toThrow('格式版本');
 const changed=structuredClone(input);changed.work[1]!.nativeDuration!.minutes=999;expect(()=>assertOrderTimeRewashInput(changed,resource,false)).toThrow('原采用');
 const noTerminal=structuredClone(input);noTerminal.scopes[0]!.terminalIds=['TEST original'];expect(()=>assertOrderTimeRewashInput(noTerminal,resource,false)).toThrow('交付范围');
 expect(()=>assertOrderTimeRewashInput(input,{kind:'order',id:id(99)},false)).toThrow('原订单');
 const duplicate=structuredClone(input);duplicate.rewashing!.push(structuredClone(duplicate.rewashing![0]!));expect(()=>assertOrderTimeRewashInput(duplicate,resource,false)).toThrow('不能重复');
});

it('requires an already effective exact native plan and preserves actual unknown without borrowing its planned time',()=>{
 const {input,row,resource}=fixture();row.introducedAt=at(2);row.introducedEventRef='audit_events:'+id(7);
 const scope:BulkWashingScopeView={scopeId:row.scopeId,lineId:row.lineId,factoryDecisionId:null,quantityVersion:row.quantityVersion,quantity:4,planId:row.planId,mode:'after_receipt',label:'TEST receipt',revision:4,receivedAt:at(0),availableAt:at(0),canLogistics:true,canInspect:false,canCorrect:false,windows:[],facts:[],
  ledger:{applicable:true,conflict:false,reasons:[],sent:4,washed:4,qualified:2,remaining:2,complete:false,completedAt:null,sendable:0}};
 const saved:StoredOrderTimePlan={id:id(8),resource,revision:2,input,targets:{},identityHash:'TEST local basis',time:{now:at(2),scenarioId:null,revision:0},actorId:id(9),eventRef:row.introducedEventRef,changeKind:'arrangement'};
 const command:Extract<BulkWashingCommand,{kind:'send'}>={kind:'send',planId:row.planId,scopeId:row.scopeId,quantityVersion:row.quantityVersion,expectedRevision:4,occurredAt:null,note:'TEST original',quantity:1,reworkOfInspectionId:row.inspectionId,rewashWorkId:row.intentId};
 expect(()=>assertWashingReworkBinding(saved,scope,command)).not.toThrow();expect(command.occurredAt).toBeNull();
 expect(()=>assertWashingReworkBinding(saved,scope,{...command,occurredAt:at(1)})).toThrow('早于');
 expect(()=>assertWashingReworkBinding(saved,scope,{...command,quantity:3})).toThrow('超过');
 expect(()=>assertWashingReworkBinding(saved,{...scope,factoryDecisionId:id(10)},command)).toThrow('不一致');
 const withoutPlan={...command};delete withoutPlan.rewashWorkId;expect(()=>assertWashingReworkBinding(saved,scope,withoutPlan)).toThrow('先由有权人员');
 expect(()=>assertWashingReworkBinding(saved,scope,{...command,reworkOfInspectionId:id(99)})).toThrow('不一致');
});
