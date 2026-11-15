import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JOURNEY_NODES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {FixedScheduleBasis} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import {attachFixedJourneySchedule} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import {journeyBusinessProgress} from '../../apps/api/src/production-platform/journey-business-progress.js';
import {journeyStages} from '../../apps/api/src/production-platform/journey-projection.js';
import {journeyVisualProgress} from '../../apps/api/src/production-platform/journey-visual-progress.js';
import {journeyWashingFact} from '../../apps/api/src/production-platform/journey-washing-facts.js';
import {cockpitMilestones,milestoneContains} from '../../apps/web/src/cockpit-milestones.js';
import {CockpitFrameworkNodes} from '../../apps/web/src/cockpit-framework-nodes.js';
import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {WashingPlan} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
const at=(hour:number)=>new Date(Date.UTC(2027,0,1,hour)).toISOString(),unknown={precision:'unknown'} as const;
const duration={minutes:120,calendar:'beijing_sunday_excluded' as const,reminder:{enabled:false,percent:70}};
function fixture(mode:'factory'|'after_receipt'='after_receipt'){
 const key=mode==='factory'?'bulk_factory_washing':'bulk_return_washing',wash=key+':red',check=key+'_inspection:red';
 const work=[wash,check].map((id,index)=>({id,canonicalWorkRef:id,stage:mode==='factory'?6:7,dependsOn:index?[wash]:[],start:at(index*2),end:at(index*2+2),minutes:120,calendar:'continuous' as const,responsibilitySlaRef:'original washing scope'}));
 const pending=()=>({ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:false,notYetReady:true,evidenceRefs:[]});
 const scope={scopeRef:'po:red',lineId:'red',targetRevision:'TEST-v1',terminalIds:[check],customerGoal:at(48),plannedReadiness:true,work,facts:{[wash]:pending(),[check]:pending()}};
 const basis:FixedScheduleBasis={version:'fixed-schedule-basis-v1',policyVersion:'order-time-plan-v1',scopeRevision:'v1',factRevision:'facts',pending:false,termination:null,scopes:[scope],framework:[{scopeRef:'po:red',lineId:'red',route:'B',reference:'TEST-v1',revision:1,effectiveAt:at(0),customerDate:'2027-01-02',milestones:[{key:'planned_shipment',date:'2027-01-02',at:at(40),plannedAt:at(4),workIds:[check],relatedWorkIds:[wash,check]}]}]};
 const item={id:'TEST-order',orderId:'TEST-order',createdAt:at(0),lines:[{id:'red',po:'TEST-red'}],stages:journeyStages(JOURNEY_NODES.map(definition=>({...definition,instanceId:definition.key,state:'not_applicable',progressApplicability:'not_applicable',current:true,round:null,occurrence:null,owner:null,operator:null,assignmentHistory:[],countsInProgress:false,expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_set',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null})))} as unknown as OrderJourney;
 return {item,basis,key,wash,check};
}
const nodes=(item:OrderJourney)=>item.stages.flatMap(stage=>stage.nodes);
function batch():BulkWashingScopeView{return {scopeId:'receipt:1',lineId:'red',factoryDecisionId:null,quantityVersion:'v1',quantity:30,planId:'original',mode:'after_receipt',label:'TEST',revision:1,receivedAt:at(0),availableAt:at(0),canLogistics:false,canInspect:false,canCorrect:false,windows:[{id:'wash',kind:'washing',state:'completed',startedAt:at(0),dueAt:at(2),completedAt:at(3),minutes:120,overdueMinutes:60},{id:'check',kind:'inspection',state:'completed',startedAt:at(3),dueAt:at(5),completedAt:at(4),minutes:120,overdueMinutes:0}],ledger:{applicable:true,conflict:false,reasons:[],sent:30,washed:30,qualified:20,remaining:10,complete:false,completedAt:null,sendable:0},facts:[]};}
const plan:WashingPlan={id:'original',orderId:'TEST-order',lineId:'red',version:1,document:{arrangement:{mode:'after_receipt',accounting:'additional',reference:'original',revision:1,washing:duration,inspection:duration},fee:{kind:'pending'},sourceRef:'original'}};

it.each(['factory','after_receipt'] as const)('shows only adopted %s work under its exact shipment scope without creating tasks or clocks',mode=>{
 const {item,basis,key}=fixture(mode),before=structuredClone(basis);
 attachFixedJourneySchedule(item,basis,at(0),{nextChange:false});
 attachFixedJourneySchedule(item,basis,at(0),{nextChange:false});
 const rows=nodes(item).filter(row=>row.key.startsWith(key));expect(rows).toHaveLength(2);
 expect(rows.every(row=>row.stage===(mode==='factory'?'production':'receiving'))).toBe(true);
 expect(item.stages.find(stage=>stage.key===rows[0]!.stage)!.state).toBe('pending');
 for(const row of rows){
  expect(row).toMatchObject({state:'pending',current:true,progressApplicability:'applicable',actualAt:null,enteredAt:null,owner:null,risks:[],nativeWindows:[],records:[{url:'/ui/digital-production?factory=TEST-order',lineId:'red',mode:'read'}]});
  expect(milestoneContains(cockpitMilestones(item)[0]!,row)).toBe(true);
 }
 expect(basis).toEqual(before);
 const milestone=cockpitMilestones(item)[0]!,html=renderToStaticMarkup(createElement(CockpitFrameworkNodes,{nodes:nodes(item).filter(node=>milestoneContains(milestone,node)),lines:item.lines,selectedId:undefined,onSelect(){},asOf:at(0)}));
 expect(html).toContain(rows[0]!.label);expect(html).toContain(rows[1]!.label);expect(html).toContain('2027-01-01');expect(html).toContain('未完成');
 basis.scopes[0]!.work=[];basis.scopes[0]!.terminalIds=[];
 attachFixedJourneySchedule(item,basis,at(0),{nextChange:false});
 expect(nodes(item).some(row=>row.key.startsWith(key))).toBe(false);
});

it('retains partial quantities and independent wash/check completion in progress, instead of counting a received batch as the whole PO',()=>{
 const {item,basis,key,wash,check}=fixture(),row=batch();
 const project=(expected:number)=>{
  basis.scopes[0]!.facts[wash]=journeyWashingFact([row],[plan],'red',key,expected,at(8));
  basis.scopes[0]!.facts[check]=journeyWashingFact([row],[plan],'red',key+'_inspection',expected,at(8));
  attachFixedJourneySchedule(item,basis,at(8),{nextChange:false});
  item.businessProgress=journeyBusinessProgress(item,at(8));return nodes(item).filter(node=>node.key.startsWith(key));
 };
 expect(project(100).every(node=>node.state==='active'&&node.actualAt===null)).toBe(true);
 expect(item.stages.find(stage=>stage.key==='receiving')!.state).toBe('active');
 expect(journeyVisualProgress(item,at(8)).actualRatio).toBe(0);
 let rows=project(30);expect(rows.map(node=>node.state)).toEqual(['completed','active']);
 expect(rows[0]!.actualAt).toBe(at(3));expect(rows[1]!.actualAt).toBeNull();
 expect(item.businessProgress!.requirements.filter(req=>req.key.startsWith(key)).map(req=>req.completed)).toEqual([true,false]);
 expect(journeyVisualProgress(item,at(8)).actualRatio).toBe(0.5);
 row.ledger.qualified=30;rows=project(30);
 expect(rows.map(node=>node.actualAt)).toEqual([at(3),at(4)]);
 expect(item.stages.find(stage=>stage.key==='receiving')!.state).toBe('completed');
 expect(journeyVisualProgress(item,at(8)).actualRatio).toBe(1);
});

it('keeps a known overdue original batch beside an unknown window, including its frozen calendar and deadline',()=>{
 const {item,basis,key,wash}=fixture(),first=batch(),second=batch();second.scopeId='receipt:2';second.windows[0]!.startedAt=null;second.windows[0]!.dueAt=null;
 const fact=journeyWashingFact([first,second],[plan],'red',key,100,at(8));basis.scopes[0]!.facts[wash]=fact;
 const original=structuredClone(fact);attachFixedJourneySchedule(item,basis,at(8),{nextChange:false});
 const node=nodes(item).find(node=>node.key===key)!;
 expect(node.risks).toContain('overdue');expect(node.enteredAt).toBeNull();expect(node.actualAt).toBeNull();
 expect(node.nativeWindows).toMatchObject([{evidence:'washing:receipt:1:wash',deadline:at(2),startedAt:at(0)},{evidence:'washing:receipt:2:wash',deadline:null,startedAt:null}]);
 expect(basis.scopes[0]!.facts[wash]).toEqual(original);expect(original.ownWindows![0]!.calendar).toBe('beijing_sunday_excluded');
});

it('covers every selected PO once and does not let one complete PO or repeated projection complete the remaining PO',()=>{
 const {item,basis,key,wash,check}=fixture();
 for(const id of [wash,check])basis.scopes[0]!.facts[id]={...basis.scopes[0]!.facts[id]!,businessCompleted:true,completed:{precision:'instant',at:at(1)}};
 const blue=structuredClone(basis.scopes[0]!);blue.scopeRef='po:blue';blue.lineId='blue';
 for(const work of blue.work){const oldId=work.id;work.id=work.id.replace(':red',':blue');work.canonicalWorkRef=work.id;work.dependsOn=work.dependsOn.map(id=>id.replace(':red',':blue'));blue.facts[work.id]={...blue.facts[oldId]!,businessCompleted:false,completed:unknown};delete blue.facts[oldId];}
 blue.terminalIds=[check.replace(':red',':blue')];basis.scopes.push(blue);
 attachFixedJourneySchedule(item,basis,at(8),{nextChange:false});attachFixedJourneySchedule(item,basis,at(8),{nextChange:false});
 const requirements=journeyBusinessProgress(item,at(8)).requirements.filter(req=>req.key.startsWith(key));
 expect(nodes(item).filter(node=>node.key.startsWith(key))).toHaveLength(4);
 expect(requirements).toHaveLength(2);expect(requirements.every(req=>!req.completed&&req.instanceIds.length===2)).toBe(true);
 const red=cockpitMilestones(item)[0]!;expect(nodes(item).filter(node=>node.key.startsWith(key)&&milestoneContains(red,node))).toHaveLength(2);
});

it('preserves completed facts on termination and stops only the unfinished washing work',()=>{
 const {item,basis,key,wash}=fixture();basis.scopes[0]!.facts[wash]={...basis.scopes[0]!.facts[wash]!,businessCompleted:true,completed:{precision:'date',date:'2027-01-01'}};
 basis.termination={kind:'special_closure',at:at(6)};attachFixedJourneySchedule(item,basis,at(50),{nextChange:false});
 const rows=nodes(item).filter(node=>node.key.startsWith(key));expect(rows[0]).toMatchObject({state:'completed',actualDate:'2027-01-01',actualAt:null});
 expect(rows[1]).toMatchObject({state:'cancelled',actualAt:null,risks:[]});
});

it('exposes the original accessory record without inferring not-applicable or completion from an empty accessory list',()=>{
 const {item,basis}=fixture();const scope=basis.scopes[0]!,work={...scope.work[0]!,id:'warehouse_accessories',canonicalWorkRef:'warehouse_accessories',dependsOn:[]};
 scope.work=[work];scope.terminalIds=[work.id];scope.facts={[work.id]:{ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:[]}};
 basis.framework![0]!.milestones=[{key:'accessories_ready',date:'2027-01-02',at:at(40),plannedAt:at(2),workIds:[work.id],relatedWorkIds:[work.id]}];
 attachFixedJourneySchedule(item,basis,at(0),{nextChange:false});
 let row=nodes(item).find(node=>node.key==='warehouse_accessories')!;
 expect(row).toMatchObject({state:'pending',planningOnly:true,countsInProgress:false,actualAt:null,records:[{url:'/ui/digital-production?bulk=TEST-order',mode:'read'}]});
 expect(milestoneContains(cockpitMilestones(item)[0]!,row)).toBe(true);expect(cockpitMilestones(item)[0]!.completed).toBe(false);
 scope.facts[work.id]={...scope.facts[work.id]!,businessCompleted:true,completed:{precision:'date',date:'2027-01-01'},evidenceRefs:['original accessory preparation']};
 attachFixedJourneySchedule(item,basis,at(24),{nextChange:false});row=nodes(item).find(node=>node.key==='warehouse_accessories')!;
 expect(row).toMatchObject({state:'completed',actualDate:'2027-01-01',actualAt:null});expect(cockpitMilestones(item)[0]!.completed).toBe(true);
});
