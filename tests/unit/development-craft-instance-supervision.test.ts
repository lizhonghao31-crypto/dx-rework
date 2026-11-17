import {compileJourneySelectionClock} from '../../apps/api/src/production-platform/journey-selection-clock.js';
import {journeySelectionNodes} from '../../apps/api/src/production-platform/journey-selection-facts.js';
import {minimalJourneyFacts} from '../../apps/api/src/production-platform/journey-fact-model.js';
import type {DevelopmentCraftRow} from '../../apps/api/src/production-platform/development-craft-instance-evidence.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {JOURNEY_NODES,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {evaluateSlaPlan,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {developmentSlaPlan} from '../../apps/api/src/production-platform/development-sla-enrollment.js';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {attachJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
import {journeyStages} from '../../apps/api/src/production-platform/journey-projection.js';
vi.mock('../../apps/api/src/production-platform/development-sla-enrollment.js',()=>({developmentSlaPlan:vi.fn()}));
const at=(minute:number)=>new Date(Date.parse('2026-11-15T22:00:00.000Z')+minute*60000).toISOString();
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const time={now:at(31),scenarioId:null,revision:0};
const plan:SlaPlan={nodes:[{id:'development_craft_dispatch',label:'发工艺',stage:2,parameterKey:'development_craft_dispatch',kind:'duration',minutes:30,offsetDays:null,applicable:'yes',countsProgress:false,dependsOn:[],anchorKey:'published',targetKey:null,includedIn:null,includedPosition:'start'}],anchors:{published:{precision:'instant',value:at(0),source:'TEST actual publication'}},warningPercent:70,stageBufferMinutes:0};
function node(id:string,entered:string|null,due:string|null,key='development_craft_dispatch'):JourneyNode{
 const d=JOURNEY_NODES.find(n=>n.key===key)!;
 return {key:d.key,label:d.label,stage:d.stage,instanceId:id,state:'active',current:true,round:1,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:due,expectedKind:due?'sla':'unset',expectedPrecision:due?'instant':'missing',actualAt:null,actualQuality:'missing',enteredAt:entered,sla:'running',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[{domain:'task',id,url:null,version:1,lineId:null,mode:'read'}],inheritedFrom:null,countsInProgress:false,unavailableReason:null,progressApplicability:'applicable'};
}
function subject(nodes:JourneyNode[]):OrderJourney{return {id:'source',sourceId:'source',orderId:null,designStyleNo:'TEST independent craft windows',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:at(0),deliveryDate:null,selectedRound:1,adoptedRound:null,sourceVersion:2,instructionVersion:null,lines:[],poDeliveryDates:[],links:[],stages:journeyStages(nodes),progress:{development:null,bulk:null},hitReasons:[]};}
const row=(id:string,step:string,minute:number)=>({task_id:id,task_kind:'development_craft_dispatch',route_instance_id:'source-route',route_version:1,state:'ready',entered_at:at(minute),entered_quality:'现场登记',completed_at:null,completed_quality:'缺失',due_at:at(minute+30),warning_at:at(minute+21),returned:false,rejected:false,correction_id:null,sla_basis:{seconds:1800,enteredAt:at(minute),warningRatio:0.7,basis:[`craft-step:${step}`,'craft-kind:printing']}});
afterEach(()=>vi.restoreAllMocks());
it.each(['development_craft_dispatch','development_materials'].flatMap(kind=>[false,true].map(exclusive=>[kind,exclusive] as const)))('retains contradictory original completion for exact %s chronology without exposing it as a valid actual, strict=%s',async(kind,exclusive)=>{
 const selectedPlan:SlaPlan={...plan,nodes:plan.nodes.map(value=>({...value,id:kind,parameterKey:kind}))};
 const base=row('bad-task','own-step',0),own={...base,sla_basis:{...base.sla_basis,exclusive},task_kind:kind,state:'completed',completed_at:at(60),completed_quality:'现场登记'};
 const evidence=await read([own],selectedPlan),before=structuredClone(own);
 const item=subject([node('bad-task',at(0),at(30),kind)]);
 attachJourneySupervision(item,selectedPlan,selectedPlan,evaluateSlaPlan(selectedPlan,evidence.facts,time,{mode:'read_projection'}),time,{original:1,current:2},false,evidence);
 expect(item.supervision?.assessment).toBe('partially_unavailable');
 expect(item.supervision?.coverage.some(value=>value.key==='fact_time')).toBe(true);
 const timing=item.stages.flatMap(stage=>stage.nodes)[0]!.timing!;
 expect(timing.assessmentIssue?.code).toBe('actual_after_observation');expect(timing.actualEnd).toBeNull();expect(timing.status).toBe('unknown');
 expect(()=>evaluateSlaPlan(selectedPlan,evidence.facts,time)).toThrow('Actual SLA event cannot be in the future');
 expect(own).toEqual(before);
 const expired={...time,now:at(61)},later=subject([node('bad-task',at(0),at(30),kind)]);
 attachJourneySupervision(later,selectedPlan,selectedPlan,evaluateSlaPlan(selectedPlan,evidence.facts,expired,{mode:'read_projection'}),expired,{original:1,current:2},false,evidence);
 expect(later.supervision?.assessment).toBe('complete');expect(later.stages.flatMap(stage=>stage.nodes)[0]!.timing?.actualEnd).toBe(at(60));expect(later.stages.flatMap(stage=>stage.nodes)[0]!.timing?.status).toBe('completed_late');
});
describe('exact craft task supervision identity',()=>{
 it('keeps two dispatch R/D windows distinct instead of hanging the second window on both selected task IDs',async()=>{
  vi.mocked(developmentSlaPlan).mockResolvedValue({plan_json:plan,business_time:{scenarioId:null},revision:2,rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters});
  const rows=[row('first-task','first-step',0),row('second-task','second-step',3)];
  const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT t.task_id')?{rows}:sql.includes('SELECT round_number')?{rows:[{round_number:1,route_nodes:['development_craft_dispatch','development_craft_dispatch']}]}:Promise.reject(new Error('Unexpected craft fixture query: '+sql)));
  const evidence=(await developmentSlaEvidence({query} as never,'source',time))!;
  const item=subject([node('first-task',at(0),at(30)),node('second-task',at(3),at(33))]);
  attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,evidence.facts,time),time,{original:1,current:2},false,evidence);
  const actual=item.stages.flatMap(stage=>stage.nodes);
  expect(actual[0]!.timing?.actualStart).toBe(at(0));expect(actual[0]!.timing?.target.at).toBe(at(30));
  expect(actual[1]!.timing?.actualStart).toBe(at(3));expect(actual[1]!.timing?.target.at).toBe(at(33));
  expect(actual[0]!.risks).toContain('overdue');expect(actual[1]!.risks).not.toContain('overdue');
  expect(rows[0]!.entered_at).toBe(at(0));expect(rows[1]!.due_at).toBe(at(33));
 });
});

async function read(rows:DevelopmentCraftRow[],selectedPlan=plan,round?:number,adoption?:{inherited:Record<string,{taskId:string;roundNumber:number}>;published_at:string;route_nodes:string[]}){
 vi.mocked(developmentSlaPlan).mockResolvedValue({plan_json:selectedPlan,business_time:{scenarioId:null},revision:2,rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters});
 const query=vi.fn(async(sql:string,params:unknown[]=[])=>sql.startsWith('SELECT t.task_id')?{rows}:sql.includes('SELECT round_number')?{rows:[{round_number:params[1]??Math.max(...rows.map(row=>row.route_version)),route_nodes:rows.filter(row=>row.route_version===(params[1]??Math.max(...rows.map(row=>row.route_version)))).map(row=>row.task_kind),...adoption}]}:Promise.reject(new Error('Unexpected scoped fixture query: '+sql)));
 return (await developmentSlaEvidence({query} as never,'source',time,undefined,round))!;
}
function phase(rowId:string,step:string,kind:string,start:number|null,end:number|null,predecessor:string[]=[]){
 const value={...row(rowId,step,start??0),task_kind:kind,state:end===null?'ready':'completed',entered_at:start===null?null:at(start),due_at:start===null?null:at(start+(kind==='development_craft_confirmation'?30:120)),completed_at:end===null?null:at(end),completed_quality:end===null?'缺失':'已核实',predecessor_ids:predecessor};
 return {...value,sla_basis:{...value.sla_basis,seconds:kind==='development_craft_confirmation'?1800:7200}};
}
const craftPlan:SlaPlan={...plan,nodes:['development_printing','development_embroidery','development_craft_return'].map(id=>({...plan.nodes[0]!,id,label:id,parameterKey:id,minutes:id==='development_craft_return'?30:120}))};
it('keeps each parent confirmation inside its own step, including two printing-kind special steps',async()=>{
 const rows=[phase('work-A','step-A','development_printing',0,4),phase('return-A','step-A','development_craft_confirmation',4,6,['work-A']),phase('work-B','step-B','development_printing',10,15),phase('return-B','step-B','development_craft_confirmation',15,20,['work-B'])];
 const before=structuredClone(rows),e=await read(rows,craftPlan);
 expect(e.instances.find(row=>row.taskId==='work-A')?.fact.completedAt).toBe(at(6));expect(e.instances.find(row=>row.taskId==='work-B')?.fact.completedAt).toBe(at(20));
 expect(e.instances.find(row=>row.taskId==='return-A')?.fact.startedAt).toBe(at(4));expect(e.instances.find(row=>row.taskId==='return-B')?.fact.startedAt).toBe(at(15));
 expect(rows).toEqual(before);expect(e.facts.development_printing.batchWindows).toHaveLength(2);
});
it('does not borrow an earlier embroidery completion for a special step with missing actual time or readiness',async()=>{
 const missing={...phase('special','step-B','development_printing',10,null),state:'completed',completed_quality:'缺失'};
 const rows=[phase('embroider','step-A','development_embroidery',0,4),phase('confirm-A','step-A','development_craft_confirmation',4,6,['embroider']),missing,phase('confirm-B','step-B','development_craft_confirmation',null,null,['special'])];
 const e=await read(rows,craftPlan),b=e.instances.find(row=>row.taskId==='confirm-B')!;
 expect(b.fact.startedAt).toBeUndefined();expect(b.deadline.at).toBeNull();expect(e.instances.find(row=>row.taskId==='special')?.fact.completedAt).toBeUndefined();
 const n=node('confirm-B',null,null,'development_craft_confirmation'),item=subject([n]);
 attachJourneySupervision(item,craftPlan,craftPlan,evaluateSlaPlan(craftPlan,e.facts,time),time,{original:1,current:2},false,e);
 expect(n.timing?.status).toBe('unknown');expect(n.timing?.actualStart).toBeNull();expect(n.risks).toContain('unknown');
});
it('retains a known completion but never rates its responsibility on an unverified start',async()=>{
 const unverified={...row('unverified','step-A',0),state:'completed',entered_quality:'补报未核实',completed_at:at(10),completed_quality:'已核实'};
 const e=await read([unverified]),n=node('unverified',at(0),at(30));n.state='completed';n.actualAt=at(10);n.actualQuality='verified';
 const item=subject([n]);attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e);
 expect(n.actualAt).toBe(at(10));expect(n.timing?.status).toBe('completed_unrated');expect(n.timing?.actualStart).toBeNull();expect(n.timing?.target.at).toBeNull();
});
it('does not authenticate an unverified captured craft R with a later trusted task handover',async()=>{
 const r={...row('mixed-start','step-A',0),entered_quality:'现场登记',task_entered_at:at(10),sla_basis:{...row('mixed-start','step-A',0).sla_basis,timeQuality:'补报未核实'}};
 const e=await read([r]),n=node('mixed-start',at(10),at(30)),item=subject([n]);
 attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e);
 expect(n.timing).toMatchObject({status:'unknown',actualStart:null,target:{at:null}});expect(e.instances[0]!.fact.startedAt).toBeUndefined();
});
it('keeps the selected older round and excludes later round task observations, including a legacy first round',async()=>{
 for(const legacy of [false,true]){
  const old={...row('old','old-step',0),...(legacy?{sla_basis:{seconds:1800,enteredAt:at(0),warningRatio:0.7,basis:[]}}:{})},later={...row('later','later-step',20),route_version:2,route_instance_id:'later-route'};
  const e=await read([old,later],plan,1),n=node('old',at(0),at(30)),item=subject([n]);
  attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e);
  expect(n.timing?.actualStart).toBe(at(0));expect(n.timing?.target.at).toBe(at(30));expect(item.supervision?.nativeFacts?.some(f=>f.sourceRef.includes('task:later'))).toBe(false);
 }
});
it('does not expose a sibling same-kind observation to an exact-task reader or another source',async()=>{
 const e=await read([row('first-task','step-A',0),row('secret-sibling','step-B',3)]),n=node('first-task',at(0),at(30)),item=subject([n]);
 attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e,new Set(['first-task']));
 expect(item.supervision?.nodes).toHaveLength(1);expect(item.supervision?.nativeFacts).toHaveLength(1);expect(JSON.stringify(item.supervision)).not.toContain('secret-sibling');
 const foreign=subject([node('first-task',at(0),at(30))]);foreign.sourceId='another-source';
 attachJourneySupervision(foreign,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e);
 expect(foreign.supervision?.nodes).toEqual([]);expect(foreign.supervision?.nativeFacts).toEqual([]);
});
it('keeps ambiguous step identity unknown instead of falling back to a later kind-level task',async()=>{
 const bad={...row('bad','step-A',0),sla_basis:{seconds:1800,enteredAt:at(0),warningRatio:0.7,basis:['craft-step:step-A','craft-step:step-B','craft-kind:printing']}},e=await read([bad,row('good','step-C',3)]),n=node('bad',at(0),at(30)),item=subject([n]);
 attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e);
 expect(n.timing?.status).toBe('unknown');expect(n.timing?.target.at).toBeNull();expect(n.timing?.actualStart).toBeNull();
});

it('keeps exact task windows through persisted facts and independently crosses each cached risk boundary',async()=>{
 const now={...time,now:at(20)},e=await read([row('first-task','step-A',0),row('second-task','step-B',3)]);
 // Legacy type template can be disabled while actual captured tasks still exist.
 const ownPlan={...plan,nodes:plan.nodes.map(n=>({...n,applicable:'no' as const}))};
 const raw=subject([node('first-task',at(0),at(30)),node('second-task',at(3),at(33))]);raw.asOf=now.now;
 const item=structuredClone(raw),inputs={plan:ownPlan,original:ownPlan,facts:e.facts,instances:e.instances};
 attachJourneySupervision(item,ownPlan,ownPlan,evaluateSlaPlan(ownPlan,e.facts,now),now,{original:1,current:2},false,e);
 const stored=JSON.parse(JSON.stringify(minimalJourneyFacts(item,inputs))),replayed=structuredClone(raw);
 expect(stored.sla.instances).toHaveLength(2);
 attachJourneySupervision(replayed,stored.sla.plan,stored.sla.original,evaluateSlaPlan(stored.sla.plan,stored.sla.facts,now),now,{original:1,current:2},false,{facts:stored.sla.facts,instances:stored.sla.instances});
 expect(replayed.stages.flatMap(stage=>stage.nodes).map(n=>n.timing)).toEqual(item.stages.flatMap(stage=>stage.nodes).map(n=>n.timing));
 const tasks=e.instances.map(i=>({id:i.taskId,kind:i.taskKind,sourceId:i.sourceId,orderId:null,assigneeId:null,requiredRole:'TEST',routeInstanceId:i.routeRef,routeVersion:i.round,policyVersion:1,enteredAt:i.fact.startedAt??null,dueAt:i.deadline.at,warningAt:i.warningAt,deadlineMode:'duration',deadlineExclusive:false,state:'active' as const}));
 const {frames}=compileJourneySelectionClock(item,raw,stored.sla,tasks,journeySelectionNodes(raw.stages.flatMap(stage=>stage.nodes)),{finished:false,factoryFinished:false,sampleFinished:false,sentLineIds:[]},now);
 const firstLate=frames.find(f=>Date.parse(f.from)===Date.parse(at(30))+1)!;expect(firstLate).toBeDefined();expect(firstLate.risks.find(r=>r.id==='first-task')!.risks).toContain('overdue');expect(firstLate.risks.find(r=>r.id==='second-task')!.risks).not.toContain('overdue');
 const secondLate=frames.find(f=>Date.parse(f.from)===Date.parse(at(33))+1)!;expect(secondLate.risks.every(r=>r.risks.includes('overdue'))).toBe(true);
});

it('retains inclusive and explicitly strict own captured cutoff equality for running and completed tasks',async()=>{
 for(const exclusive of [false,true])for(const complete of [false,true]){
  const r={...row('task','step-A',1),state:complete?'completed':'ready',completed_at:complete?at(31):null,completed_quality:complete?'已核实':'缺失',sla_basis:{...row('task','step-A',1).sla_basis,exclusive}};
  const e=await read([r]),n=node('task',at(1),at(31));if(complete)n.state='completed';
  const item=subject([n]);attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,time),time,{original:1,current:2},false,e);
  expect(n.timing?.status).toBe(complete?exclusive?'completed_late':'completed_on_time':exclusive?'overdue':'warning');expect(n.timing?.target.exclusive).toBe(exclusive);
 }
});

it('retains only the explicitly inherited craft result when a later round redoes sewing',async()=>{
 const rows=[phase('emb-A','step-A','development_embroidery',0,4),phase('ret-A','step-A','development_craft_confirmation',4,6,['emb-A']),phase('special-B','step-B','development_printing',10,15),phase('ret-B','step-B','development_craft_confirmation',15,20,['special-B'])];
 const inherited={development_embroidery:{taskId:'emb-A',roundNumber:1},development_printing:{taskId:'special-B',roundNumber:1},development_craft_confirmation:{taskId:'ret-B',roundNumber:1}};
 const e=await read(rows,craftPlan,2,{inherited,published_at:at(25),route_nodes:['development_sewing','development_tail_check']});
 expect(e.facts.development_printing).toMatchObject({businessCompleted:true,completedAt:at(20)});expect(e.facts.development_embroidery).toMatchObject({businessCompleted:true,completedAt:at(6)});expect(e.facts.development_craft_return).toMatchObject({businessCompleted:true,completedAt:at(20)});
 expect(e.originalFacts.development_printing.completedAt).toBe(at(20));expect(e.instances.every(i=>i.round===1)).toBe(true);
});
it('never restores unadopted, foreign, later, cancelled or currently redone craft results',async()=>{
 const rows=[phase('work-A','step-A','development_printing',0,4),phase('ret-A','step-A','development_craft_confirmation',4,6,['work-A'])];
 const valid={development_printing:{taskId:'work-A',roundNumber:1}};
 for(const [inherited,route_nodes,published_at] of [[{},[],at(20)],[{development_printing:{taskId:'foreign-task',roundNumber:1}},[],at(20)],[{development_printing:{taskId:'work-A',roundNumber:3}},[],at(20)],[valid,['development_printing'],at(20)],[valid,[],at(40)]] as Array<[Record<string,{taskId:string;roundNumber:number}>,string[],string]>){
  const e=await read(rows,craftPlan,2,{inherited,published_at,route_nodes});expect(e.facts.development_printing?.businessCompleted).not.toBe(true);
 }
 const e=await read([{...rows[0]!,state:'cancelled'},rows[1]!],craftPlan,2,{inherited:valid,published_at:at(20),route_nodes:[]});expect(e.facts.development_printing?.businessCompleted).not.toBe(true);
});
