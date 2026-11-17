import {expect,it} from 'vitest';
import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {OrderTimeWashingReworkPlan} from '@dx-rework/contracts/order-time-washing-rework';
import type {WashingPlan} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {journeyWashingReworkFact,journeyUnplannedWashingRework} from '../../apps/api/src/production-platform/journey-washing-rework-facts.js';
import {evaluateFixedScheduleScope} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {fixedScheduleBasisSnapshot,type FixedScheduleBasis} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import {evaluateJourneyFramework} from '../../apps/api/src/production-platform/journey-time-framework.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at=(hour:number)=>new Date(Date.parse('2026-11-10T00:00:00.000Z')+hour*3600000).toISOString();
const policy={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
function fixture(){
 const arrangement={mode:'after_receipt' as const,accounting:'additional' as const,reference:'TEST frozen adoption',revision:1,washing:policy,inspection:policy};
 const row:OrderTimeWashingReworkPlan={intentId:id(8),orderId:id(1),lineId:id(2),scopeId:'receipt:'+id(3),factoryDecisionId:null,
  quantityVersion:'TEST-q1',inspectionId:id(4),quantity:1,planId:id(5),round:1,inspectionAt:at(2),arrangement,
  introducedAt:at(2.5),introducedEventRef:'audit_events:'+id(6)};
 const plan:WashingPlan={id:row.planId,orderId:row.orderId,lineId:row.lineId,version:1,document:{arrangement,fee:{kind:'pending'},sourceRef:'TEST original adoption'}};
 const common={scopeId:row.scopeId,quantityVersion:row.quantityVersion,recordedAt:at(6),operator:'TEST',note:'TEST genuine defect',voided:false};
 const scope:BulkWashingScopeView={scopeId:row.scopeId,lineId:row.lineId,factoryDecisionId:null,quantityVersion:row.quantityVersion,quantity:4,
  planId:row.planId,mode:'after_receipt',label:'TEST original receipt',revision:6,receivedAt:at(0),availableAt:at(0),canLogistics:false,canInspect:false,canCorrect:false,
  ledger:{applicable:true,conflict:false,reasons:[],sent:4,washed:4,qualified:3,remaining:1,complete:false,completedAt:null,sendable:0,
   rework:{sent:1,washed:1,qualified:0,available:[],rounds:{[id(9)]:1}}},
  facts:[{...common,id:row.inspectionId,kind:'inspection',completionId:id(7),quantity:4,qualifiedQuantity:3,occurredAt:at(2)},
   {...common,id:id(9),kind:'send',quantity:1,reworkOfInspectionId:row.inspectionId,rewashWorkId:row.intentId,occurredAt:at(3)},
   {...common,id:id(10),kind:'return',sendId:id(9),quantity:1,occurredAt:at(4)},
   {...common,id:id(11),kind:'inspection',completionId:id(10),quantity:1,qualifiedQuantity:0,occurredAt:at(5)}],
  windows:[{id:id(9),kind:'washing',state:'completed',startedAt:at(3),dueAt:at(4),completedAt:at(4),minutes:60,overdueMinutes:0},
   {id:id(10)+':qc',kind:'inspection',state:'completed',startedAt:at(4),dueAt:at(5),completedAt:at(5),minutes:60,overdueMinutes:0}]};
 return {row,plan,scope};
}

it('keeps exact planned-round R/D/A without treating a real failed reinspection as whole-scope delivery',()=>{
 const {row,scope}=fixture();
 expect(journeyWashingReworkFact(row,scope,false,at(6))).toMatchObject({businessCompleted:true,clockStart:{at:at(3)},completed:{at:at(4)}});
 const inspection=journeyWashingReworkFact(row,scope,true,at(6));
 expect(inspection).toMatchObject({businessCompleted:true,clockStart:{at:at(4)},completed:{at:at(5)},ownWindows:[{deadline:at(5)}]});
 expect(scope.ledger.complete).toBe(false);expect(scope.facts[0]).toMatchObject({qualifiedQuantity:3,voided:false});
 const other={...row,intentId:id(12)};
 expect(journeyWashingReworkFact(other,scope,false,at(6))).toMatchObject({businessCompleted:false,clockStart:{precision:'unknown'}});
 expect(journeyWashingReworkFact({...row,quantityVersion:'TEST changed'},scope,false,at(6)).businessCompleted).toBe(false);
});

it('does not borrow another round time when this round occurrence is missing or voided',()=>{
 const {row,scope}=fixture();scope.windows[0]!.startedAt=null;
 expect(journeyWashingReworkFact(row,scope,false,at(6))).toMatchObject({clockStart:{precision:'unknown'},ownWindows:[{warningAt:null}]});
 scope.facts[1]!.voided=true;
 expect(journeyWashingReworkFact(row,scope,false,at(6))).toMatchObject({businessCompleted:false,completed:{precision:'unknown'}});
});

it('keeps a legacy native round with real occurrences and no retroactive P or duplicate garment denominator',()=>{
 const {row,plan,scope}=fixture(),start=scope.facts[1]!;
 if(start.kind!=='send')throw Error('TEST start');delete start.rewashWorkId;
 const original=structuredClone(scope),history=journeyUnplannedWashingRework(row.orderId,scope,plan,at(6));
 expect(history).toHaveLength(2);expect(history.map(value=>value.work)).toMatchObject([{start:null,end:null,rewashRound:1},{start:null,end:null,rewashRound:1}]);
 expect(history.map(value=>value.fact.completed)).toEqual([{precision:'instant',at:at(4)},{precision:'instant',at:at(5)}]);
 const current={scopeRef:'po:'+row.lineId,lineId:row.lineId,targetRevision:'TEST read',customerGoal:at(12),terminalIds:[],work:history.map(value=>value.work),facts:Object.fromEntries(history.map(value=>[value.work.id,value.fact]))};
 const result=evaluateFixedScheduleScope(current,at(6));expect(result.nodes.every(node=>node.goalDelta.kind==='unknown'&&node.goalDelta.targetAt===null)).toBe(true);
 const basis:FixedScheduleBasis={version:'fixed-schedule-basis-v1',scopeRevision:'TEST original',factRevision:'TEST native',pending:false,termination:null,scopes:[current]};
 expect(fixedScheduleBasisSnapshot(basis).scopes[0]!.work.map(work=>work.rewashRound)).toEqual([1,1]);
 const framework=evaluateJourneyFramework([{scopeRef:current.scopeRef,lineId:row.lineId,route:'B',reference:'TEST original',revision:1,effectiveAt:at(0),customerDate:'2026-11-11',milestones:[]}],[current],[result],at(6),null);
 expect(framework).toMatchObject({applicableWork:0,completedWork:0});expect(scope).toEqual(original);
});

it('never converts a formally bound new round into an unplanned historical work on refresh',()=>{
 const {row,plan,scope}=fixture();expect(journeyUnplannedWashingRework(row.orderId,scope,plan,at(6))).toEqual([]);
 expect(journeyUnplannedWashingRework(id(99),scope,plan,at(6))).toEqual([]);
});
