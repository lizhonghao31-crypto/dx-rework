import {afterEach,expect,it,vi} from 'vitest';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {evaluateSlaPlan,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {developmentSlaPlan} from '../../apps/api/src/production-platform/development-sla-enrollment.js';
import {attachJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
import type {DevelopmentCraftRow} from '../../apps/api/src/production-platform/development-craft-instance-evidence.js';
vi.mock('../../apps/api/src/production-platform/development-sla-enrollment.js',()=>({developmentSlaPlan:vi.fn()}));
afterEach(()=>vi.restoreAllMocks());
const at=(hours:number)=>new Date(Date.parse('2026-11-15T00:00:00.000Z')+hours*3600000).toISOString();
const plan:SlaPlan={nodes:[{id:'development_pattern',label:'纸样',stage:2,parameterKey:'development_pattern',kind:'duration',minutes:240,offsetDays:null,applicable:'yes',countsProgress:true,dependsOn:[],anchorKey:'publication',targetKey:null,includedIn:null,includedPosition:'start'}],anchors:{publication:{precision:'instant',value:at(0),source:'TEST original publication'}},warningPercent:70,stageBufferMinutes:0};
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const row=(id:string,start:number,round=1)=>({task_id:id,task_kind:'development_pattern',route_version:round,route_instance_id:'TEST-route-'+round,state:'ready',entered_at:at(start),task_entered_at:at(start),entered_quality:'现场登记',completed_at:null,completed_quality:'缺失',due_at:at(start+4),warning_at:at(start+2.8),sla_basis:{enteredAt:at(start),seconds:14400,calendarRef:'continuous',timeQuality:'现场登记',basis:[]},returned:false,rejected:false});
const node=(id:string,start:number,round=1):JourneyNode=>({key:'development_pattern',label:'纸样',stage:'development',instanceId:id,state:'active',round,occurrence:1,current:true,owner:null,operator:null,assignmentHistory:[],expectedAt:at(start+4),expectedKind:'sla',expectedPrecision:'instant',actualAt:null,actualQuality:'missing',enteredAt:at(start),sla:'running',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[{domain:'task',id,url:null,version:round,lineId:null,mode:'read'}],inheritedFrom:null,countsInProgress:true,unavailableReason:null});
function subject(nodes:JourneyNode[],round=1):OrderJourney{return {id:'TEST-source',sourceId:'TEST-source',orderId:null,designStyleNo:'TEST',temporaryStyleNo:null,customer:null,category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:at(0),deliveryDate:null,selectedRound:round,adoptedRound:round,sourceVersion:1,instructionVersion:null,lines:[],links:[],stages:[{key:'development',label:'开发',state:'active',nodes}],progress:{development:null,bulk:null},hitReasons:[]};}
async function evidence(rows:DevelopmentCraftRow[],round=1,adoption?:{route_nodes:string[];inherited:Record<string,{taskId:string;roundNumber:number}>},ownPlan=plan){
 vi.mocked(developmentSlaPlan).mockResolvedValue({plan_json:ownPlan,business_time:{scenarioId:null},revision:1,rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters});
 const db={query:vi.fn(async(sql:string,values:unknown[])=>{expect(values[0]).toBe('TEST-source');if(sql.startsWith('SELECT t.task_id,'))return {rows};if(sql.startsWith('SELECT round_number'))return {rows:[{round_number:round,route_nodes:['development_pattern'],inherited:{},published_at:at(0),...adoption}]};throw Error('Unexpected exact task read');})};
 return (await developmentSlaEvidence(db as never,'TEST-source',{now:at(8),scenarioId:null,revision:0}))!;
}
it('matches ordinary same-kind task IDs and rounds without copying the last kind window to both',async()=>{
 for(const round of [1,2]){
  const e=await evidence([row('TEST-first',0),row('TEST-current',2,round)],round),nodes=[node('TEST-first',0),node('TEST-current',2,round)],item=subject(nodes,round);
  attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,{now:at(8),scenarioId:null,revision:0}),{now:at(8),scenarioId:null,revision:0},{original:1,current:1},false,e);
  expect(nodes[0]!.timing).toMatchObject({id:'development_pattern:task:TEST-first',actualStart:at(0),target:{at:at(4)}});
  expect(nodes[1]!.timing).toMatchObject({id:'development_pattern:task:TEST-current',actualStart:at(2),target:{at:at(6)}});
 }
});
it('keeps an explicitly unknown current R unknown and retains a canceled task window only for its exact terminated source',async()=>{
 const current=row('TEST-current',2,2);current.entered_quality='补报未核实';
 const e=await evidence([row('TEST-old',0),current],2),own=node('TEST-current',2,2),item=subject([own],2);
 attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,e.facts,{now:at(8),scenarioId:null,revision:0}),{now:at(8),scenarioId:null,revision:0},{original:1,current:1},false,e);
 expect(own.timing).toMatchObject({status:'unknown',actualStart:null,target:{at:null}});
 const canceled={...row('TEST-canceled',0),state:'cancelled'},ended=await evidence([canceled]),selected=node('TEST-canceled',0),source=subject([selected]);selected.state='cancelled';
 attachJourneySupervision(source,plan,plan,evaluateSlaPlan(plan,ended.facts,{now:at(8),scenarioId:null,revision:0}),{now:at(8),scenarioId:null,revision:0},{original:1,current:1},false,{...ended,termination:{kind:'special_closure',at:at(0),precision:'instant',originEventRef:'TEST original closure',scopeRef:'source:TEST-source'}});
 expect(selected.timing).toMatchObject({status:'terminated',actualStart:at(0),actualEnd:null,target:{at:at(4)},termination:{overdueSeconds:0,elapsedSeconds:0}});
});
it('restores only the exact explicitly inherited completed ordinary task, retaining first-attempt history separately',async()=>{
 const old={...row('TEST-old',0),state:'completed',completed_at:at(1),completed_quality:'已核实'};
 const valid={development_pattern:{taskId:'TEST-old',roundNumber:1}};
 for(const [inherited,route_nodes,accepted] of [[{},[],false],[valid,[],true],[{development_pattern:{taskId:'TEST-foreign',roundNumber:1}},[],false],[{development_pattern:{taskId:'TEST-old',roundNumber:3}},[],false],[valid,['development_pattern'],false]] as Array<[Record<string,{taskId:string;roundNumber:number}>,string[],boolean]>){
  const e=await evidence([old],2,{route_nodes,inherited});
  expect(e.originalFacts.development_pattern).toMatchObject({startedAt:at(0),completedAt:at(1)});
  expect(e.facts.development_pattern?.businessCompleted===true).toBe(accepted);
  if(accepted)expect(e.facts.development_pattern!.evidence).toContain('inherited:TEST-old:round:1');
 }
 const rejected=await evidence([{...old,state:'cancelled'}],2,{route_nodes:[],inherited:valid});expect(rejected.facts.development_pattern).toBeUndefined();
});
it('retains the native recheck task behind the materials-plan alias through supervision facts and terminal attachment',async()=>{
 const ownPlan={...plan,nodes:[{...plan.nodes[0]!,id:'development_materials',parameterKey:'development_materials',label:'核配'}]};
 const recheck={...row('TEST-recheck',2),task_kind:'development_material_recheck'},e=await evidence([recheck],1,undefined,ownPlan);
 for(const terminated of [false,true]){
  const selected={...node('TEST-recheck',2),key:'development_material_recheck',label:'物料复核'},item=subject([selected]);
  const native={...e,...(terminated?{termination:{kind:'special_closure' as const,at:at(4),precision:'instant' as const,originEventRef:'TEST original closure',scopeRef:'source:TEST-source'}}:{})};
  attachJourneySupervision(item,ownPlan,ownPlan,evaluateSlaPlan(ownPlan,e.facts,{now:at(8),scenarioId:null,revision:0}),{now:at(8),scenarioId:null,revision:0},{original:1,current:1},false,native);
  expect(item.supervision!.nodes).toHaveLength(1);
  expect(selected.timing).toMatchObject({id:'development_materials:task:TEST-recheck',label:'物料复核',actualStart:at(2),actualEnd:null,target:{at:at(6)},status:terminated?'terminated':'overdue'});
  expect(item.supervision!.nativeFacts).toContainEqual(expect.objectContaining({id:'development_materials:task:TEST-recheck',startedAt:at(2),businessCompleted:false}));
  if(terminated)expect(selected.timing!.termination).toMatchObject({at:at(4),elapsedSeconds:7200,overdueSeconds:0});
 }
});
