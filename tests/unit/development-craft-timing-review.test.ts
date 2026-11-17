import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {digitalSlaDefaults,resolveDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {evaluateSlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {developmentSlaEvidence} from '../../apps/api/src/production-platform/development-sla-evidence.js';
import {developmentTaskTiming} from '../../apps/api/src/production-platform/development-task-timing.js';
import {DevelopmentRouteService} from '../../apps/api/src/production-platform/development-route-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {developmentSlaPlan,savedDevelopmentRoute} from '../../apps/api/src/production-platform/development-sla-enrollment.js';
import {developmentDocumentRow} from '../../apps/api/src/production-platform/development-round-repository.js';
vi.mock('../../apps/api/src/production-platform/development-sla-enrollment.js',()=>({developmentSlaPlan:vi.fn(),savedDevelopmentRoute:vi.fn()}));
vi.mock('../../apps/api/src/production-platform/development-round-repository.js',()=>({developmentDocumentRow:vi.fn()}));
const snapshot=resolveDigitalSlaSnapshot({version:1,values:digitalSlaDefaults()});
const cut='2026-10-01T00:00:00.000Z';
afterEach(()=>vi.restoreAllMocks());
describe('native craft confirmation timing',()=>{
 it.each(['印花','绣花','印绣花'])('uses the actual %s return, never the scheduled tail window',async craft=>{
  const parent=craft==='印花'?'development_printing':craft==='绣花'?'development_embroidery':'development_print_embroidery';
  vi.mocked(developmentSlaPlan).mockResolvedValue({route_nodes:[parent],rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters,revision:2,configuration_id:'frozen',plan_json:{anchors:{development_published:{value:cut}}}});
  vi.mocked(developmentDocumentRow).mockResolvedValue({document:{craft},revision:null} as never);
  for(const returned of ['2026-10-01T05:00:00.000Z','2026-10-10T05:00:00.000Z',null]){
   const rows=[{task_id:'cut',task_kind:'development_cutting',route_version:1,completed_at:cut},...(returned?[{task_id:'craft',task_kind:parent,route_version:1,completed_at:returned}]:[])];
   const db={query:vi.fn(async(sql:string,params:unknown[])=>{if(sql==='SELECT production_order_id FROM digital_production_orders WHERE source_id=$1'){expect(params).toEqual(['source']);return {rows:[]};}if(sql.startsWith('SELECT t.task_id,t.route_version,t.completed_at,a.task_kind'))return {rows};throw new Error(`Unexpected timing query: ${sql}`);})};
   const timing=await developmentTaskTiming(db as never,{task_id:'confirm',source_id:'source',task_kind:'development_craft_confirmation',route_version:1});
   expect(timing?.enteredAt).toBe(returned);expect(timing?.seconds).toBe(1800);
   expect(timing?.configurationId).toBe('frozen');
   if(returned){
    expect(timing?.basis).toEqual(['task:craft:completed']);
    const plan={nodes:[{id:'return',label:'回收确认',stage:2,parameterKey:'development_craft_return',applicable:'yes',countsProgress:false,kind:'duration',minutes:30,offsetDays:null,dependsOn:[],anchorKey:'published',targetKey:null,includedIn:null,includedPosition:'end'}],anchors:{published:{precision:'instant',value:cut,source:'published'}},warningPercent:70,stageBufferMinutes:0};
    expect(()=>evaluateSlaPlan(plan as never,{return:{startedAt:timing!.enteredAt!,completedAt:new Date(Date.parse(returned)+600000).toISOString(),evidence:'native'}},{now:'2026-10-20T00:00:00.000Z',scenarioId:null,revision:0})).not.toThrow();
   }else expect(timing?.basis).toEqual([]);
  }
 });
});
describe('pattern responsibility from an explicit material predecessor',()=>{
 it.each(['exact','wrong-source','wrong-route','wrong-round','ambiguous','incomplete'])(
  'keeps the declared recheck identity and leaves %s evidence unrated when it cannot prove that edge',async mode=>{
   vi.mocked(developmentSlaPlan).mockResolvedValue({route_nodes:['development_materials','development_pattern'],rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters,revision:2,configuration_id:'frozen',plan_json:{anchors:{development_published:{value:cut}}}});
   vi.mocked(developmentDocumentRow).mockResolvedValue({document:{craft:'无'},revision:null} as never);
   const at='2026-11-21T04:00:00.000Z',later='2026-11-21T07:00:00.000Z';
   const predecessor={task_id:'recheck',task_kind:'development_material_recheck',source_id:mode==='wrong-source'?'other-source':'source',route_version:mode==='wrong-round'?2:1,route_instance_id:mode==='wrong-route'?'other-route':'route',current_route:'route'};
   const rows=[{task_id:'initial',task_kind:'development_materials',route_version:1,completed_at:cut},{task_id:'later',task_kind:'development_material_recheck',route_version:1,completed_at:later},...(mode==='incomplete'?[]:[{task_id:'recheck',task_kind:'development_material_recheck',route_version:1,completed_at:at}])];
   const db={query:vi.fn(async(sql:string)=>{
    if(sql==='SELECT production_order_id FROM digital_production_orders WHERE source_id=$1')return {rows:[]};
    if(sql.startsWith('SELECT t.task_id,t.route_version,t.completed_at,a.task_kind'))return {rows};
    if(sql.startsWith('SELECT p.task_id,p.route_instance_id'))return {rows:[predecessor,...(mode==='ambiguous'?[{...predecessor,task_id:'later'}]:[])]};
    throw Error('Unexpected pattern timing query: '+sql);
   })};
   const timing=await developmentTaskTiming(db as never,{task_id:'pattern',source_id:'source',task_kind:'development_pattern',route_version:1});
   expect(timing?.enteredAt).toBe(mode==='exact'?at:null);
   expect(timing?.basis).toEqual(mode==='exact'?['task:recheck:completed']:[]);
   expect(timing?.configurationId).toBe('frozen');
  });
});
describe('saved synthetic start compatibility',()=>{
 it('reads an early completed return after the old planned start without changing P0 or persisted history',async()=>{
  const plan={nodes:[
   {id:'development_printing',label:'印花',stage:2,parameterKey:'development_printing',applicable:'yes',countsProgress:true,kind:'duration',minutes:5760,offsetDays:null,dependsOn:[],anchorKey:'cut',targetKey:null,includedIn:null,includedPosition:'end'},
   {id:'development_craft_return',label:'回收确认',stage:2,parameterKey:'development_craft_return',applicable:'yes',countsProgress:false,kind:'included',minutes:30,offsetDays:null,dependsOn:[],anchorKey:null,targetKey:null,includedIn:'development_printing',includedPosition:'end'},
  ],anchors:{cut:{precision:'instant',value:cut,source:'cut'}},warningPercent:70,stageBufferMinutes:0};
  const original=structuredClone(plan);
  vi.mocked(developmentSlaPlan).mockResolvedValue({plan_json:plan,business_time:{scenarioId:null},revision:2,rule_version:snapshot.ruleVersion,parameters_json:snapshot.parameters});
  const oldStart='2026-10-04T23:30:00.000Z',returned='2026-10-01T05:00:00.000Z';
  const row=(task_id:string,task_kind:string,entered_at:string,completed_at:string)=>({task_id,task_kind,entered_at,entered_quality:'现场登记',completed_at,route_version:1,state:'completed',completed_quality:'已核实',returned:false,rejected:false,due_at:'2026-10-05T00:00:00.000Z',sla_basis:{seconds:task_kind==='development_printing'?345600:1800}});
  const rows=[row('craft','development_printing',cut,returned),row('return','development_craft_confirmation',oldStart,'2026-10-01T05:10:00.000Z')];
  const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT t.task_id')?{rows}:sql.includes('SELECT round_number')?{rows:[]}:Promise.reject(new Error('Unexpected SQL')));
  const time={now:'2026-10-20T00:00:00.000Z',scenarioId:null,revision:0};
  const evidence=(await developmentSlaEvidence({query} as never,'source',time))!;
  expect(evidence.facts.development_craft_return.startedAt).toBe(returned);
  expect(evidence.originalFacts.development_craft_return.startedAt).toBe(returned);
  expect(()=>evaluateSlaPlan(plan as never,evidence.facts,time)).not.toThrow();
  expect(evidence.facts.development_craft_return.completedDeadline?.at).toBe('2026-10-05T00:00:00.000Z');
  expect(plan).toEqual(original);expect(rows[1]!.entered_at).toBe(oldStart);
 });
});
describe('physical sewing receipt on saved routes',()=>{
 it.each([
  {caseId:'direct-first',route:['development_craft_confirmation','development_sewing'],round:1,existing:false,receipt:true,next:'development_sewing'},
  {caseId:'direct-revision',route:['development_craft_confirmation','development_sewing'],round:2,existing:false,receipt:true,next:'development_sewing'},
  {caseId:'bridge-new',route:['development_craft_confirmation','development_sewing_transfer','development_sewing'],round:1,existing:false,receipt:true,next:'development_sewing'},
  {caseId:'bridge-existing',route:['development_craft_confirmation','development_sewing_transfer','development_sewing'],round:1,existing:true,receipt:false,next:'development_sewing_transfer'},
  {caseId:'confirmation-only',route:['development_craft_confirmation','development_confirmation'],round:1,existing:false,receipt:false,next:'development_confirmation'},
  {caseId:'tail-revision',route:['development_craft_confirmation','development_sewing_transfer','development_tail_check'],round:2,existing:false,receipt:false,next:'development_sewing_transfer'},
 ])('keeps the correct receipt boundary for $caseId',async({route,round,existing,receipt,next})=>{
  const service=new DevelopmentRouteService({} as Pool);
  vi.spyOn(DigitalDevelopmentService.prototype,'read').mockResolvedValue({document:{craft:'印花',washing:'免洗'}} as never);
  vi.mocked(savedDevelopmentRoute).mockResolvedValue(route as never);
  const start=vi.spyOn(service,'startRound').mockResolvedValue({taskId:'sewing'} as never);
  const system=vi.spyOn(DigitalProductionTaskService.prototype,'recordSystemRouteWithClient').mockResolvedValue(undefined);
  const db={query:vi.fn(async(sql:string)=>sql.includes("to_regclass('digital_timeline_adoptions')")?{rows:[{relation:null}]}:sql.startsWith('SELECT t.*,a.task_kind')?{rows:[{task_kind:'development_craft_confirmation',route_version:round,route_instance_id:'route'}]}:sql.startsWith('SELECT route_nodes')?{rows:[{route_nodes:route}]}:sql.startsWith('SELECT 1')?{rows:[],rowCount:existing?1:0}:sql.startsWith('INSERT INTO audit_events')?{rows:[],rowCount:1}:Promise.reject(new Error('Unexpected query')))};
  await service.advance(db as unknown as PoolClient,{actorId:'actor',requestId:'request'} as never,'source','confirmation');
  expect(start).toHaveBeenCalledWith(db,expect.anything(),'source',next,'route',round,'confirmation','confirmation',null,receipt,undefined);
  expect(system).toHaveBeenCalledTimes(receipt?1:0);
  expect(db.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO audit_events'))).toHaveLength(receipt?1:0);
 });
});
