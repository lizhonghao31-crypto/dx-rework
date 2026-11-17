import {describe,it,expect} from 'vitest';
import {orderedSlaNodes,slaBusinessProgress,evaluateSlaPlan,type SlaPlan,type SlaPlanNode,type SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import type {AdoptedCraftStep} from '@dx-rework/contracts/digital-craft';
import type {FactoryEvaluationRoute,FactorySlaInstance} from '../../apps/api/src/production-platform/factory-evaluation-route.js';
import {factoryEvaluationPlan} from '../../apps/api/src/production-platform/factory-sla-evidence.js';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {journeyStages} from '../../apps/api/src/production-platform/journey-projection.js';
import {attachJourneySupervision,type JourneyTimingInputs} from '../../apps/api/src/production-platform/journey-supervision.js';
import {minimalJourneyFacts} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {journeySelectionNodes} from '../../apps/api/src/production-platform/journey-selection-facts.js';
import {compileJourneySelectionClock} from '../../apps/api/src/production-platform/journey-selection-clock.js';

const baseNode=(id:string,dependsOn:string[]=[]):SlaPlanNode=>({id,label:'TEST '+id,stage:5,parameterKey:id,applicable:'yes',countsProgress:true,kind:'duration',minutes:60,offsetDays:null,dependsOn,anchorKey:dependsOn.length?null:'TEST-origin',targetKey:null,includedIn:null,includedPosition:'end'});
const base=():SlaPlan=>({nodes:[baseNode('bulk_cutting'),...['bulk_printing','bulk_embroidery','bulk_print_embroidery'].map(id=>baseNode(id,['bulk_cutting'])),baseNode('bulk_qc',['bulk_printing']),baseNode('sourcing_approval'),baseNode('warehouse_accessories'),baseNode('warehouse_dispatch',['bulk_qc','sourcing_approval','warehouse_accessories'])],anchors:{'TEST-origin':{precision:'unknown',reason:'TEST no invented actual handoff'}},warningPercent:70,stageBufferMinutes:0});
function fixture(kinds:Array<'special'|'printing'|'embroidery'>=['special','special'],added=false){
 const steps=kinds.map((craftKind,index)=>({stepId:'TEST-step-'+index,craftKind,sequence:index+1,...(craftKind==='special'?{specialCraft:{id:'test_'+index,definition:{name:'TEST special '+index}}}:{})})) as AdoptedCraftStep[];
 const frozen:FactoryEvaluationRoute={adoptionId:'TEST original adoption',routeRef:'TEST current frozen route',sourceRef:'TEST immutable source',work:[],route:[],replacedWorkIds:[],groups:[]};
 let previous=added?null:'bulk_cutting';
 for(const step of steps){
  const id=added?`bulk_${step.craftKind}:${step.stepId}`:`bulk_${step.craftKind==='special'?'special_'+step.specialCraft!.id:step.craftKind}:${step.stepId}`,qc=`bulk_qc:${step.stepId}`;
  for(const [nodeId,parameterKey,phase,deps] of [[id,step.craftKind==='special'?'bulk_special_'+step.specialCraft!.id:'bulk_'+step.craftKind,'logistics',previous?[previous]:[]],[qc,'bulk_qc','qc',[id]]] as const){
   frozen.work.push({id:nodeId,parameterKey,dependsOn:[...deps],minutes:phase==='qc'?30:120,calendar:'continuous',canonicalWorkRef:`order:TEST:step:${step.stepId}:${phase}`,planningParameterRef:'TEST formal plan ref',responsibilitySlaRef:'TEST original quota',responsibilityMinutes:phase==='qc'?30:120,responsibilityCalendar:'continuous',accountingRole:added?'added_work':'original_work'});
   frozen.route.push({kind:phase==='qc'?'bulk_qc':'process_logistics',position:frozen.route.length,nodeId,stepId:step.stepId,phase});
  }
  previous=qc;
 }
 frozen.work.push({id:'warehouse_dispatch',parameterKey:'warehouse_dispatch',dependsOn:[previous!,'sourcing_approval','warehouse_accessories'],minutes:30,calendar:'continuous',canonicalWorkRef:'order:TEST:warehouse_dispatch',planningParameterRef:'TEST original P',responsibilitySlaRef:'TEST original D'});
 if(added)frozen.groups=[{nodeIds:frozen.route.map(row=>row.nodeId),lastNodeId:previous!,handoffNodeId:'warehouse_dispatch'}];
 return {steps,frozen};
}
describe('original frozen factory supervision graph',()=>{
 it.each([[['special','special'],false],[['special'],false],[['special','printing'],false],[['printing','special'],false],[['printing','printing'],false],[['special','special'],true]] as const)('keeps exact frozen steps, each QC and dispatch prerequisites for %j added=%s',(kinds,added)=>{
  const {steps,frozen}=fixture([...kinds],added),before=structuredClone(frozen),plan=factoryEvaluationPlan(base(),null,steps,frozen);
  expect(()=>orderedSlaNodes(plan)).not.toThrow();
  const exact=frozen.route.map(row=>row.nodeId),byId=new Map(plan.nodes.map(node=>[node.id,node]));
  for(const row of frozen.route){const original=frozen.work.find(work=>work.id===row.nodeId)!;expect(byId.get(row.nodeId)).toMatchObject({id:row.nodeId,dependsOn:original.dependsOn,applicable:'yes',countsProgress:true});}
  expect(byId.get('warehouse_dispatch')!.dependsOn).toEqual(expect.arrayContaining([exact.at(-1)!,'sourcing_approval','warehouse_accessories']));
  expect(plan.nodes.filter(node=>node.applicable==='yes'&&node.countsProgress&&['bulk_printing','bulk_embroidery','bulk_print_embroidery','bulk_qc'].includes(node.id))).toEqual([]);
  expect(slaBusinessProgress(plan,[exact[0]!]).stages.find(stage=>stage.stage===5)!.completed).toBe(1);
  expect(frozen).toEqual(before);
 });
 it('keeps missing dependencies, duplicate IDs and cycles invalid rather than dropping a factory or QC obligation',()=>{
  const {steps,frozen}=fixture();const missing=structuredClone(frozen);missing.work[0]!.dependsOn=['TEST absent prerequisite'];
  expect(()=>orderedSlaNodes(factoryEvaluationPlan(base(),null,steps,missing))).toThrow('Unknown SLA dependency');
  const cycle=structuredClone(frozen);cycle.work[0]!.dependsOn=[cycle.route.at(-1)!.nodeId];
  expect(()=>orderedSlaNodes(factoryEvaluationPlan(base(),null,steps,cycle))).toThrow('SLA dependency cycle');
  const duplicate=structuredClone(frozen);duplicate.route.push(duplicate.route[0]!);
  expect(()=>factoryEvaluationPlan(base(),null,steps,duplicate)).toThrow('Duplicate factory route node');
  const duplicatedWork=structuredClone(frozen);duplicatedWork.work.push(duplicatedWork.work[0]!);
  expect(()=>factoryEvaluationPlan(base(),null,steps,duplicatedWork)).toThrow('Duplicate frozen factory work');
 });
 it('preserves no-craft and original legacy routes without requiring a new frozen route',()=>{
  expect(()=>orderedSlaNodes(factoryEvaluationPlan(base(),null))).not.toThrow();
  expect(factoryEvaluationPlan(base(),'bulk_printing').nodes.find(node=>node.id==='warehouse_dispatch')!.dependsOn).toContain('sourcing_approval');
 });
});

it('retains exact step/task identity through stored facts, selection-clock rebuild and restricted visibility',()=>{
 const {frozen,steps}=fixture(),plan=factoryEvaluationPlan(base(),null,steps,frozen),at=(minutes:number)=>new Date(Date.parse('2026-11-17T00:00:00Z')+minutes*60000).toISOString(),time={now:at(60),scenarioId:null,revision:0};
 // A step happens to equal a PO ID. It must never be parsed as that PO.
 const factoryInstances:FactorySlaInstance[]=frozen.route.map((row,index)=>({nodeId:row.nodeId,stepId:row.stepId!,phase:row.phase as 'qc'|'logistics',routeRef:frozen.routeRef,taskIds:['TEST-task-'+index],lineIds:['TEST-real-po'],snapshotId:'TEST original snapshot'}));
 const raw:JourneyNode[]=factoryInstances.map((instance,index)=>({key:instance.phase==='qc'?'bulk_qc':'process_logistics',label:'TEST exact '+index,stage:'post_cutting',instanceId:instance.taskIds[0]!,state:'active',current:true,round:1,occurrence:index+1,owner:null,operator:null,assignmentHistory:[],expectedAt:at(index*10+120),expectedKind:'sla',expectedPrecision:'instant',actualAt:null,actualQuality:'missing',enteredAt:at(index*10),sla:'running',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[{domain:'task',id:instance.taskIds[0]!,url:null,version:1,lineId:null,mode:'read'}],inheritedFrom:null,countsInProgress:true,unavailableReason:null,progressApplicability:'applicable'}));
 const untimed:OrderJourney={asOf:time.now,id:'TEST-order',sourceId:null,orderId:'TEST-order',designStyleNo:'TEST',temporaryStyleNo:null,customer:null,category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:at(0),deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:1,lines:[{id:'TEST-real-po',po:'TEST original PO',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1},{id:'TEST-step-0',po:'TEST unrelated PO',color:'白',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}],poDeliveryDates:[],links:[],stages:journeyStages(raw),progress:{development:null,bulk:null},hitReasons:[]};
 const facts:Record<string,SlaNodeFact>=Object.fromEntries(factoryInstances.map((instance,index)=>[instance.nodeId,{evidence:'TEST native '+index,startedAt:at(index*10),batchCoverageComplete:true,batchWindows:[{startedAt:at(index*10),deadline:at(index*10+120),warningAt:at(index*10+84),completedAt:null,complete:false,evidence:'TEST native '+index}]}]));
 const inputs:JourneyTimingInputs={plan,original:base(),facts,factoryInstances},item=structuredClone(untimed),authorized=new Set(raw.map(node=>node.instanceId));
 attachJourneySupervision(item,plan,inputs.original,evaluateSlaPlan(plan,facts,time),time,{original:1,current:1},false,inputs,authorized);
 for(const [index,node]of item.stages.flatMap(stage=>stage.nodes).entries()){
  expect(node.timing).toMatchObject({id:factoryInstances[index]!.nodeId,actualStart:at(index*10),target:{at:at(index*10+120)}});expect(node.timings).toBeUndefined();
  expect(node.label).toBe(plan.nodes.find(row=>row.id===factoryInstances[index]!.nodeId)!.label);
  expect(node.timing!.windows![0]!.scopeLabel).toContain('TEST original PO');expect(node.timing!.windows![0]!.scopeLabel).not.toContain('TEST unrelated PO');
 }
 const tasks=raw.map(node=>({id:node.instanceId,kind:node.key as 'process_logistics'|'bulk_qc',state:'ready' as const,sourceId:null,orderId:'TEST-order',assigneeId:null,requiredRole:'TEST',routeInstanceId:frozen.routeRef,routeVersion:1,policyVersion:1,enteredAt:node.enteredAt,dueAt:node.expectedAt,warningAt:null,deadlineMode:'duration',deadlineExclusive:false}));
 const stored=minimalJourneyFacts(item,inputs,tasks);expect(stored.sla.factoryInstances).toEqual(factoryInstances);
 const rebuilt=compileJourneySelectionClock(item,untimed,stored.sla,tasks,journeySelectionNodes(raw),{finished:false,factoryFinished:false,sampleFinished:false,sentLineIds:[]},time);
 expect(rebuilt.frames[0]!.risks).toEqual(item.stages.flatMap(stage=>stage.nodes).map(node=>({id:node.instanceId,risks:node.risks})));
 const restricted=structuredClone(untimed);restricted.stages=journeyStages([structuredClone(raw[0]!)]);
 attachJourneySupervision(restricted,plan,inputs.original,evaluateSlaPlan(plan,facts,time),time,{original:1,current:1},false,inputs,new Set([raw[0]!.instanceId]));
 expect(restricted.supervision!.nativeFacts!.map(fact=>fact.id)).toEqual([factoryInstances[0]!.nodeId]);
 expect(restricted.supervision!.nodes.filter(node=>factoryInstances.some(instance=>instance.nodeId===node.id)).map(node=>node.id)).toEqual([factoryInstances[0]!.nodeId]);
});
